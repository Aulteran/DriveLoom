// Optional SMTP. Without a mailer, every email-based flow is simply off.
import nodemailer from 'nodemailer';

/** `html`, when given, is sent as the HTML alternative of the plain-text body. */
export interface Mailer { send(to: string, subject: string, text: string, html?: string): Promise<void> }

export function createSmtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return { async send(to, subject, text, html) { await transport.sendMail({ from, to, subject, text, ...(html ? { html } : {}) }); } };
}

export type SmtpSecurity = 'tls' | 'starttls' | 'none';
export interface SmtpOptions { host: string; port: number; security: SmtpSecurity; username: string | null; password: string | null; from: string }

/** SMTP from structured settings (the admin page). Short timeouts so a wrong host fails fast. */
export function createSmtpMailerFromOptions(o: SmtpOptions): Mailer {
  const transport = nodemailer.createTransport({
    host: o.host, port: o.port, secure: o.security === 'tls', requireTLS: o.security === 'starttls', ignoreTLS: o.security === 'none',
    ...(o.username ? { auth: { user: o.username, pass: o.password ?? '' } } : {}),
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
  return { async send(to, subject, text, html) { await transport.sendMail({ from: o.from, to, subject, text, ...(html ? { html } : {}) }); } };
}

/** In-memory mailer for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; subject: string; text: string; html?: string }[] = [];
  fail = false;
  async send(to: string, subject: string, text: string, html?: string): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.sent.push(html === undefined ? { to, subject, text } : { to, subject, text, html });
  }
  /** Most recent code (digits) sent to an address. */
  lastCode(to: string): string | undefined {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m ? /\b(\d{8})\b/.exec(m.text)?.[1] : undefined;
  }
}
