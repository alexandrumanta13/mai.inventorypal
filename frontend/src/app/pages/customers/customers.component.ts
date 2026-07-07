import { Component, OnInit, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

interface Customer {
  id: number;
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  city?: string;
  state?: string;
  country?: string;
  primary_domain_id?: number;
  created_at: string;
  updated_at: string;
}

@Component({
  selector: 'app-customers',
  standalone: false,
  templateUrl: './customers.component.html',
  styleUrls: ['./customers.component.scss']
})
export class CustomersComponent implements OnInit, OnDestroy {
  customers: Customer[] = [];
  loading = true;
  errorMessage = '';
  activeTab: 'list' | 'insights' = 'list';

  // Pagination
  currentPage = 1;
  pageSize = 100;
  totalCustomers = 0;
  totalPages = 0;

  // Filters
  searchTerm = '';
  cityFilter = '';

  // Sorting
  sortBy = 'createdAt';
  sortOrder: 'ASC' | 'DESC' = 'DESC';

  // Analytics
  analytics: any = null;
  loadingAnalytics = false;
  showAnalytics = true;

  // Email Quality
  emailQuality: any = null;
  loadingEmailQuality = false;

  // Contact Completeness
  contactCompleteness: any = null;
  loadingContactCompleteness = false;

  // Email Domains
  emailDomains: any[] = [];
  loadingEmailDomains = false;

  // Risk Assessment
  riskAssessment: any = null;
  loadingRiskAssessment = false;

  // Search debounce
  private searchSubject = new Subject<string>();

  constructor(private http: HttpClient) {
    // Setup live search with 300ms debounce
    this.searchSubject.pipe(
      debounceTime(300),
      distinctUntilChanged()
    ).subscribe(searchTerm => {
      this.searchTerm = searchTerm;
      this.currentPage = 1;
      this.loadCustomers();
    });
  }

  ngOnInit() {
    this.loadCustomers();
    this.loadAnalytics();
    this.loadEmailQuality();
    this.loadContactCompleteness();
    this.loadEmailDomains();
    this.loadRiskAssessment();
  }

  ngOnDestroy() {
    this.searchSubject.complete();
  }

  loadCustomers() {
    this.loading = true;
    this.errorMessage = '';

    const params: any = {
      page: this.currentPage,
      limit: this.pageSize,
      sortBy: this.sortBy,
      sortOrder: this.sortOrder
    };

    if (this.searchTerm) {
      params.search = this.searchTerm;
    }

    if (this.cityFilter) {
      params.city = this.cityFilter;
    }

    this.http.get<any>('/api/customers', { params }).subscribe({
      next: (response) => {
        this.customers = response.data || [];
        this.totalCustomers = response.pagination?.total || 0;
        this.totalPages = response.pagination?.totalPages || 0;
        this.loading = false;
      },
      error: (error) => {
        console.error('Failed to load customers:', error);
        this.errorMessage = 'Customers could not be loaded.';
        this.loading = false;
      }
    });
  }

  onPageChange(page: number) {
    this.currentPage = page;
    this.loadCustomers();
  }

  onSearchInput(searchTerm: string) {
    this.searchSubject.next(searchTerm);
  }

  onFilterChange() {
    this.currentPage = 1;
    this.loadCustomers();
  }

  onSort(column: string) {
    if (this.sortBy === column) {
      // Toggle sort order
      this.sortOrder = this.sortOrder === 'ASC' ? 'DESC' : 'ASC';
    } else {
      this.sortBy = column;
      this.sortOrder = 'ASC';
    }
    this.loadCustomers();
  }

  setActiveTab(tab: 'list' | 'insights') {
    this.activeTab = tab;
  }

  trackCustomer(_: number, customer: Customer): number {
    return customer.id;
  }

  getPages(): number[] {
    const pages: number[] = [];
    const maxVisible = 5;

    let start = Math.max(1, this.currentPage - Math.floor(maxVisible / 2));
    let end = Math.min(this.totalPages, start + maxVisible - 1);

    if (end - start < maxVisible - 1) {
      start = Math.max(1, end - maxVisible + 1);
    }

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    return pages;
  }

  getFullName(customer: Customer): string {
    const parts = [customer.first_name, customer.last_name].filter(Boolean);
    return parts.join(' ') || '-';
  }

  loadAnalytics() {
    this.loadingAnalytics = true;
    this.http.get<any>('/api/customers/analytics/overview').subscribe({
      next: (response) => {
        this.analytics = response;
        this.loadingAnalytics = false;
      },
      error: (error) => {
        console.error('Failed to load analytics:', error);
        this.loadingAnalytics = false;
      }
    });
  }

  loadEmailQuality() {
    this.loadingEmailQuality = true;
    this.http.get<any>('/api/customers/analytics/email-quality').subscribe({
      next: (response) => {
        this.emailQuality = response;
        this.loadingEmailQuality = false;
      },
      error: (error) => {
        console.error('Failed to load email quality:', error);
        this.loadingEmailQuality = false;
      }
    });
  }

  loadContactCompleteness() {
    this.loadingContactCompleteness = true;
    this.http.get<any>('/api/customers/analytics/contact-completeness').subscribe({
      next: (response) => {
        this.contactCompleteness = response;
        this.loadingContactCompleteness = false;
      },
      error: (error) => {
        console.error('Failed to load contact completeness:', error);
        this.loadingContactCompleteness = false;
      }
    });
  }

  loadEmailDomains() {
    this.loadingEmailDomains = true;
    this.http.get<any>('/api/customers/analytics/email-domains').subscribe({
      next: (response) => {
        this.emailDomains = response || [];
        this.loadingEmailDomains = false;
      },
      error: (error) => {
        console.error('Failed to load email domains:', error);
        this.loadingEmailDomains = false;
      }
    });
  }

  loadRiskAssessment() {
    this.loadingRiskAssessment = true;
    this.http.get<any>('/api/customers/analytics/risk-assessment').subscribe({
      next: (response) => {
        this.riskAssessment = response;
        this.loadingRiskAssessment = false;
      },
      error: (error) => {
        console.error('Failed to load risk assessment:', error);
        this.loadingRiskAssessment = false;
      }
    });
  }

  toggleAnalytics() {
    this.showAnalytics = !this.showAnalytics;
  }

  getQualityPercentage(status: string): number {
    if (!this.emailQuality || !this.analytics?.total) return 0;
    const count = this.emailQuality[status] || 0;
    return (count / this.analytics.total) * 100;
  }

  getCompletenessPercentage(type: string): number {
    if (!this.contactCompleteness || !this.analytics?.total) return 0;
    const count = this.contactCompleteness[type] || 0;
    return (count / this.analytics.total) * 100;
  }
}
