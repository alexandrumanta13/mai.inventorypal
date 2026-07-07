import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { createConnection, Connection, RowDataPacket } from 'mysql2/promise';
import { DomainsService } from '@modules/domains/services/domains.service';
import { CustomersService } from '@modules/customers/services/customers.service';
import { Email } from '@modules/emails/entities/email.entity';
import { EmailsService } from '@modules/emails/services/emails.service';
import { PaymentMethod } from '@modules/customers/entities/customer.entity';
import { ImportSourceType } from '@shared/enums/import-source.enum';

interface WooCustomerRow {
  customer_id: string;
  user_id: number;
  email: string;
  first_name: string;
  last_name: string;
  date_last_active: string;
  total_orders: number;
  total_spent: string;
}

interface WooAddressRow {
  order_id: number;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  phone: string;
}

interface WooOrderRow {
  id: number;
  billing_email: string;
  payment_method: string;
}

@Injectable()
export class WooCommerceImportService {
  private readonly logger = new Logger(WooCommerceImportService.name);

  constructor(
    private readonly domainsService: DomainsService,
    private readonly customersService: CustomersService,
    private readonly emailsService: EmailsService,
    @InjectRepository(Email)
    private readonly emailRepository: Repository<Email>,
  ) {}

  /**
   * Import customers from a WooCommerce domain
   */
  async importFromDomain(domainId: number): Promise<{
    customersImported: number;
    customersUpdated: number;
    emailsLinked: number;
    errors: number;
  }> {
    const domain = await this.domainsService.findOne(domainId);

    if (!domain.is_active) {
      throw new Error(`Domain ${domain.domain_name} is not active`);
    }

    this.logger.log(`Starting WooCommerce import from ${domain.domain_name}...`);

    let connection: Connection;
    const result = {
      customersImported: 0,
      customersUpdated: 0,
      emailsLinked: 0,
      errors: 0,
    };

    try {
      // Connect to WooCommerce database
      connection = await createConnection({
        host: domain.db_host,
        user: domain.db_user,
        password: domain.db_password,
        database: domain.db_name,
      });

      this.logger.log(`Connected to ${domain.domain_name} database`);

      // HPOS: Get unique customers from wp_wc_orders (billing email)
      const [customersRaw] = await connection.query(
        `SELECT DISTINCT
           billing_email as email,
           customer_id,
           MIN(id) as first_order_id,
           COUNT(*) as total_orders,
           SUM(total_amount) as total_spent
         FROM ${domain.db_prefix}wc_orders
         WHERE billing_email IS NOT NULL AND billing_email != ''
         GROUP BY billing_email, customer_id`
      );
      const customers = customersRaw as any[];

      this.logger.log(`Found ${customers.length} unique customers in ${domain.domain_name}`);

      // Get addresses from wp_wc_order_addresses (latest per email)
      const [addressesRaw] = await connection.query(
        `SELECT oa.*
         FROM ${domain.db_prefix}wc_order_addresses oa
         INNER JOIN (
           SELECT email, MAX(order_id) as max_order_id
           FROM ${domain.db_prefix}wc_order_addresses
           WHERE address_type = 'billing' AND email IS NOT NULL AND email != ''
           GROUP BY email
         ) latest ON oa.email = latest.email AND oa.order_id = latest.max_order_id
         WHERE oa.address_type = 'billing'`
      );
      const addresses = addressesRaw as WooAddressRow[];

      // Get payment methods from wp_wc_orders (latest per email)
      const [ordersRaw] = await connection.query(
        `SELECT o.billing_email, o.payment_method
         FROM ${domain.db_prefix}wc_orders o
         INNER JOIN (
           SELECT billing_email, MAX(id) as max_id
           FROM ${domain.db_prefix}wc_orders
           WHERE billing_email IS NOT NULL AND billing_email != ''
           GROUP BY billing_email
         ) latest ON o.billing_email = latest.billing_email AND o.id = latest.max_id`
      );
      const orders = ordersRaw as WooOrderRow[];

      // Create maps for quick lookup
      const addressMap = new Map(addresses.map((a) => [a.email.toLowerCase(), a]));
      const paymentMap = new Map(orders.map((o) => [o.billing_email.toLowerCase(), o.payment_method]));

      // Process each customer
      for (const wooCustomer of customers) {
        try {
          const normalizedEmail = wooCustomer.email.toLowerCase().trim();
          const address = addressMap.get(normalizedEmail);
          const paymentMethodRaw = paymentMap.get(normalizedEmail);

          if (
            await this.emailsService.storeTypoCandidate(
              {
                email: normalizedEmail,
                firstName: address?.first_name || undefined,
                lastName: address?.last_name || undefined,
                phone: address?.phone || undefined,
                country: address?.country || undefined,
                city: address?.city || undefined,
                acquisitionSource: `woocommerce_${domain.domain_name}_typo_review`,
                acquisitionDate: new Date(),
                funnelStage: 'woocommerce_customer',
              },
              ImportSourceType.API,
              `woocommerce_${domain.id}_${wooCustomer.customer_id || normalizedEmail}`,
            )
          ) {
            result.errors++;
            continue;
          }

          if (!(await this.emailsService.isImportCandidateAccepted(normalizedEmail))) {
            result.errors++;
            continue;
          }

          // Map WooCommerce payment method to our enum
          let paymentMethod: PaymentMethod = PaymentMethod.UNKNOWN;
          if (paymentMethodRaw) {
            if (paymentMethodRaw.includes('cod')) {
              paymentMethod = PaymentMethod.CASH_ON_DELIVERY;
            } else if (paymentMethodRaw.includes('card') || paymentMethodRaw.includes('stripe')) {
              paymentMethod = PaymentMethod.CARD;
            } else if (paymentMethodRaw.includes('bank') || paymentMethodRaw.includes('transfer')) {
              paymentMethod = PaymentMethod.BANK_TRANSFER;
            }
          }

          // Check if customer already exists
          const existingCustomer = await this.customersService.findByEmail(normalizedEmail);

          if (existingCustomer) {
            // Update existing customer
            result.customersUpdated++;
          } else {
            // Create new customer
            result.customersImported++;
          }

          // Upsert customer
          const customer = await this.customersService.upsert({
            email: normalizedEmail,
            firstName: address?.first_name || '',
            lastName: address?.last_name || '',
            phone: address?.phone,
            company: address?.company,
            address_1: address?.address_1,
            address_2: address?.address_2,
            city: address?.city,
            state: address?.state,
            postcode: address?.postcode,
            country: address?.country,
            preferredPaymentMethod: paymentMethod,
            primaryDomainId: existingCustomer ? existingCustomer.primary_domain_id : domainId,
            woocommerceCustomerId: wooCustomer.customer_id?.toString() || '',
          });

          // Associate customer with domain
          await this.customersService.associateWithDomain(customer.id, domainId, {
            woocommerceCustomerId: wooCustomer.customer_id?.toString() || '',
            orderCount: wooCustomer.total_orders || 0,
            totalSpent: parseFloat(wooCustomer.total_spent || '0'),
          });

          // Link email records to customer
          const emailsUpdated = await this.emailRepository.update(
            { email: normalizedEmail },
            { customerId: customer.id }
          );

          if (emailsUpdated.affected && emailsUpdated.affected > 0) {
            result.emailsLinked += emailsUpdated.affected;
          }
        } catch (error) {
          this.logger.error(`Error importing customer ${wooCustomer.email}: ${error.message}`);
          result.errors++;
        }
      }

      this.logger.log(
        `Completed import from ${domain.domain_name}: ${result.customersImported} new, ${result.customersUpdated} updated, ${result.emailsLinked} emails linked`
      );
    } catch (error) {
      this.logger.error(`Failed to import from ${domain.domain_name}: ${error.message}`);
      throw error;
    } finally {
      if (connection) {
        await connection.end();
      }
    }

    return result;
  }

  /**
   * Import from all active domains
   */
  async importFromAllDomains(): Promise<{ results: any[] }> {
    const activeDomains = await this.domainsService.findActive();
    const results = [];

    for (const domain of activeDomains) {
      try {
        const result = await this.importFromDomain(domain.id);
        results.push({
          domain: domain.domain_name,
          ...result,
        });
      } catch (error) {
        this.logger.error(`Failed to import from ${domain.domain_name}: ${error.message}`);
        results.push({
          domain: domain.domain_name,
          error: error.message,
        });
      }
    }

    return { results };
  }
}
