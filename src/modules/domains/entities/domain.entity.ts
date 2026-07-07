import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Customer } from '@modules/customers/entities/customer.entity';

@Entity('domains')
export class Domain {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: number;

  @Column({ type: 'varchar', length: 100, unique: true })
  domain_name: string;

  @Column({ type: 'varchar', length: 100 })
  display_name: string;

  @Column({ type: 'boolean', default: false })
  is_active: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  db_host: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  db_user: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  db_password: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  db_name: string;

  @Column({ type: 'varchar', length: 20, default: 'wp_' })
  db_prefix: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  woo_consumer_key: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  woo_consumer_secret: string;

  @CreateDateColumn({ type: 'timestamp' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updated_at: Date;

  @OneToMany(() => Customer, (customer) => customer.primaryDomain)
  customers: Customer[];
}
