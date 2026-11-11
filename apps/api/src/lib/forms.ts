import { and, eq, sql } from 'drizzle-orm';
import {
  checkFormAnswers,
  type FormAnswerDto,
  type FormAnswerValue,
  type FormDto,
  type FormResponseDto,
  type PublicFormDto,
} from '@agenda/shared';
import type { Db } from '../db/client.js';
import { formResponses, forms, type Form } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { AppError } from './errors.js';

type Q = Pick<Db, 'select'>;

export const toPublicForm = (f: Form): PublicFormDto => ({ id: f.id, name: f.name, description: f.description, fields: f.fields, serviceIds: f.serviceIds });
export const toFormDto = (f: Form, responses: number): FormDto => ({ ...toPublicForm(f), active: f.active, responses });

/** Active forms attached to a service. */
export async function formsForService(db: Q, tenantId: string, serviceId: string): Promise<Form[]> {
  const rows = await db.select().from(forms).where(and(eq(forms.tenantId, tenantId), eq(forms.active, true)));
  return rows.filter((f) => f.serviceIds.includes(serviceId));
}

/** Saves (or replaces) the answers of a form for a booking, encrypted, with a snapshot of the questions. */
export async function saveResponse(
  db: Pick<Db, 'insert' | 'update' | 'query'>,
  o: {
    tenantId: string;
    customerId: string;
    appointmentId: string | null;
    form: Form;
    values: Record<string, FormAnswerValue>;
    source: 'staff';
    authorId?: string | null;
    authorName?: string | null;
  },
) {
  const err = checkFormAnswers(o.form.fields, o.values);
  if (err) throw new AppError(422, err, err === 'form_required' ? 'Answer the required questions' : 'Invalid answer');
  const answers: FormAnswerDto[] = o.form.fields.map((f) => ({ fieldId: f.id, label: f.label, type: f.type, value: o.values[f.id] ?? null }));
  const values = {
    formName: o.form.name,
    answersEnc: encryptSecret(JSON.stringify(answers)),
    source: o.source,
    authorId: o.authorId ?? null,
    authorName: o.authorName ?? null,
    updatedAt: new Date(),
  };
  const existing = o.appointmentId
    ? await db.query.formResponses.findFirst({ where: and(eq(formResponses.appointmentId, o.appointmentId), eq(formResponses.formId, o.form.id)) })
    : null;
  if (existing) {
    await db.update(formResponses).set(values).where(eq(formResponses.id, existing.id));
    return existing.id;
  }
  const [row] = await db
    .insert(formResponses)
    .values({ tenantId: o.tenantId, customerId: o.customerId, appointmentId: o.appointmentId, formId: o.form.id, ...values })
    .returning({ id: formResponses.id });
  return row!.id;
}

/** Answered questionnaires of a customer (or one booking), decrypted. */
export async function listResponses(db: Pick<Db, 'execute'>, tenantId: string, where: { customerId?: string; appointmentId?: string }): Promise<FormResponseDto[]> {
  const res = await db.execute<{
    id: string; form_id: string | null; form_name: string; appointment_id: string | null; answers_enc: string; source: 'customer' | 'staff';
    author_name: string | null; created_at: Date; service_name: string | null; starts_at: Date | null;
  }>(sql`
    select r.id, r.form_id, r.form_name, r.appointment_id, r.answers_enc, r.source, r.author_name, r.created_at, s.name as service_name, a.starts_at
    from form_responses r
    left join appointments a on a.id = r.appointment_id
    left join services s on s.id = a.service_id
    where r.tenant_id = ${tenantId}
      ${where.customerId ? sql`and r.customer_id = ${where.customerId}` : sql``}
      ${where.appointmentId ? sql`and r.appointment_id = ${where.appointmentId}` : sql``}
    order by r.created_at desc limit 200`);
  return res.rows.map((r) => {
    let answers: FormAnswerDto[] = [];
    try {
      answers = JSON.parse(decryptSecret(r.answers_enc)) as FormAnswerDto[];
    } catch {
      answers = [];
    }
    return {
      id: r.id,
      formId: r.form_id,
      formName: r.form_name,
      appointmentId: r.appointment_id,
      serviceName: r.service_name,
      appointmentAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
      answers,
      source: r.source,
      authorName: r.author_name,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
}

export const responseCounts = async (db: Pick<Db, 'execute'>, tenantId: string) => {
  const res = await db.execute<{ form_id: string; n: string }>(sql`select form_id, count(*) as n from form_responses where tenant_id = ${tenantId} and form_id is not null group by form_id`);
  return new Map(res.rows.map((r) => [r.form_id, Number(r.n)]));
};
