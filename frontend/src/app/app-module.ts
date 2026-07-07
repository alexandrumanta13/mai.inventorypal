import { NgModule, provideBrowserGlobalErrorListeners } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { provideHttpClient, withInterceptorsFromDi, HTTP_INTERCEPTORS } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing-module';
import { App } from './app';
import { LayoutComponent } from './layout/layout.component';
import { DashboardComponent } from './pages/dashboard/dashboard.component';
import { EmailsComponent } from './pages/emails/emails.component';
import { CustomersComponent } from './pages/customers/customers.component';
import { ImportComponent } from './pages/import/import.component';
import { VerificationComponent } from './pages/verification/verification.component';
import { LoginComponent } from './auth/components/login/login.component';
import { AuthInterceptor } from './auth/interceptors/auth.interceptor';
import { GmailScanProgressComponent } from './shared/components/gmail-scan-progress.component';

@NgModule({
  declarations: [
    App,
    LayoutComponent,
    DashboardComponent,
    EmailsComponent,
    CustomersComponent,
    ImportComponent
  ],
  imports: [
    BrowserModule,
    CommonModule,
    FormsModule,
    AppRoutingModule,
    LoginComponent, // Standalone component
    GmailScanProgressComponent, // Standalone component
    VerificationComponent // Standalone component
  ],
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptorsFromDi()),
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    }
  ],
  bootstrap: [App]
})
export class AppModule { }
