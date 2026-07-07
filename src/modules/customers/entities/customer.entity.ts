import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, OneToMany, Index } from 'typeorm';
import { Domain } from '@modules/domains/entities/domain.entity';
import { Email } from '@modules/emails/entities/email.entity';

export enum PaymentMethod {
  CARD = 'card',
  CASH_ON_DELIVERY = 'cash_on_delivery',
  BANK_TRANSFER = 'bank_transfer',
  UNKNOWN = 'unknown',
}

@Entity('customers')
@Index('idx_customer_email', ['email'])
@Index('idx_customer_primary_domain', ['primary_domain_id'])
@Index('idx_customer_city', ['city'])
@Index('idx_customer_state', ['state'])
export class Customer {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  first_name: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  last_name: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  company: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address_1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address_2: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  state: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  postcode: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  country: string;

  @Column({ type: 'enum', enum: PaymentMethod, default: PaymentMethod.UNKNOWN })
  preferred_payment_method: PaymentMethod;

  @Column({ type: 'bigint', nullable: true })
  primary_domain_id: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  woocommerce_customer_id: string;

  @Column({ type: 'int', default: 0 })
  total_orders: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  total_spent: number;

  @Column({ type: 'date', nullable: true })
  last_order_date: Date;

  @Column({ type: 'enum', enum: ['clean', 'typo'], nullable: true })
  typo_scan_status: 'clean' | 'typo';

  @Column({ type: 'timestamp', nullable: true })
  typo_scanned_at: Date;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  @ManyToOne(() => Domain, (domain) => domain.customers, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'primary_domain_id' })
  primaryDomain: Domain;

  @OneToMany(() => Email, (email) => email.customer)
  emails: Email[];
}
