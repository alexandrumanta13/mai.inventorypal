import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Customer } from './customer.entity';
import { Domain } from '@modules/domains/entities/domain.entity';

@Entity('customer_domains')
@Index('idx_customer_domain_unique', ['customer_id', 'domain_id'], { unique: true })
export class CustomerDomain {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  customer_id: number;

  @Column({ type: 'bigint' })
  domain_id: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  woocommerce_customer_id: string;

  @Column({ type: 'int', default: 0 })
  order_count: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  total_spent: number;

  @Column({ type: 'date', nullable: true })
  first_order_date: Date;

  @Column({ type: 'date', nullable: true })
  last_order_date: Date;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @ManyToOne(() => Domain, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'domain_id' })
  domain: Domain;
}
