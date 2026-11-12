// Optional SMTP. Without a mailer, every email-based flow is simply off.
import nodemailer from 'nodemailer';

export interface Mailer { send(to: string, subject: string, text: string): Promise<void> }

export function createSmtpMailer(url: string, from: string): Mailer {
  const transport = nodemailer.createTransport(url);
  return { async send(to, subject, text) { await transport.sendMail({ from, to, subject, text }); } };
}

/** In-memory mailer for tests. */
export class MemoryMailer implements Mailer {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  fail = false;
  async send(to: string, subject: string, text: string): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.sent.push({ to, subject, text });
  }
  /** Most recent code (digits) sent to an address. */
  lastCode(to: string): string | undefined {
    const m = [...this.sent].reverse().find((x) => x.to === to);
    return m ? /\b(\d{8})\b/.exec(m.text)?.[1] : undefined;
  }
}
