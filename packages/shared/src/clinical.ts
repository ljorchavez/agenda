import { z } from 'zod';

/**
 * Clinical record for health businesses.
 * - Medicine, psychology, physiotherapy and nutrition: NOM-004-SSA3-2012 "Del expediente clínico"
 *   (psychology and nutrition adapt the history and notes to the service, 5.16).
 * - Dentistry: NOM-013-SSA2-2015 (historia clínica estomatológica with odontogram).
 * Documents are templates of sections and fields; a signed document can't be changed (only an
 * "nota aclaratoria" can be added).
 */

export const CLINICAL_FIELD_TYPES = [
  'text',
  'longtext',
  'number',
  'select',
  'yesno',
  'date',
  'vitals',
  'anthropometry',
  'diagnoses',
  'medications',
  'odontogram',
  'pain',
  'signatures',
] as const;
export type ClinicalFieldType = (typeof CLINICAL_FIELD_TYPES)[number];

export interface ClinicalField {
  id: string;
  label: string;
  type: ClinicalFieldType;
  required?: boolean;
  options?: string[];
  unit?: string;
  help?: string;
}
export interface ClinicalSection {
  id: string;
  title: string;
  fields: ClinicalField[];
}
export const CLINICAL_KINDS = ['history', 'evolution', 'interconsult', 'referral', 'prescription', 'consent', 'addendum'] as const;
export type ClinicalKind = (typeof CLINICAL_KINDS)[number];
export interface ClinicalTemplate {
  id: string;
  kind: ClinicalKind;
  title: string;
  /** Rule it follows, shown on the document */
  norm: string;
  sections: ClinicalSection[];
}

// ---- Field values ----
export interface Vitals {
  ta?: string;
  fc?: number | null;
  fr?: number | null;
  temp?: number | null;
  spo2?: number | null;
  peso?: number | null;
  talla?: number | null;
}
export interface Anthropometry {
  peso?: number | null;
  talla?: number | null;
  cintura?: number | null;
  cadera?: number | null;
  grasa?: number | null;
}
export interface Diagnosis {
  /** CIE-10 code, optional */
  code?: string;
  text: string;
}
export interface Medication {
  name: string;
  dose: string;
  route: string;
  frequency: string;
  duration?: string;
}
export const TOOTH_STATES = ['sano', 'caries', 'obturado', 'corona', 'endodoncia', 'ausente', 'extraccion', 'implante', 'fractura', 'protesis'] as const;
export type ToothState = (typeof TOOTH_STATES)[number];
export const TOOTH_SURFACES = ['O', 'M', 'D', 'V', 'L'] as const;
export interface ToothMark {
  state: ToothState;
  surfaces?: string[];
  note?: string;
}
/** FDI tooth number → mark (only teeth with something to note) */
export type Odontogram = Record<string, ToothMark>;
export const PERMANENT_TEETH = {
  upper: ['18', '17', '16', '15', '14', '13', '12', '11', '21', '22', '23', '24', '25', '26', '27', '28'],
  lower: ['48', '47', '46', '45', '44', '43', '42', '41', '31', '32', '33', '34', '35', '36', '37', '38'],
};
export const PRIMARY_TEETH = {
  upper: ['55', '54', '53', '52', '51', '61', '62', '63', '64', '65'],
  lower: ['85', '84', '83', '82', '81', '71', '72', '73', '74', '75'],
};
export interface SignatureMark {
  name: string;
  /** PNG data URL drawn on screen */
  image: string | null;
  /** e.g. "Madre", "Tutor" when someone signs for the patient */
  relation?: string;
}
export interface ConsentSignatures {
  patient?: SignatureMark;
  doctor?: SignatureMark;
  witness1?: SignatureMark;
  witness2?: SignatureMark;
}
export type ClinicalContent = Record<string, unknown>;

/** BMI from kg and cm (one decimal), or null */
export function bmi(peso?: number | null, talla?: number | null): number | null {
  if (!peso || !talla) return null;
  const m = talla / 100;
  return Math.round((peso / (m * m)) * 10) / 10;
}

// ---- Shared pieces ----
const vitals = (required = false): ClinicalField => ({ id: 'signos', label: 'Signos vitales', type: 'vitals', required });
const diagnoses: ClinicalField = { id: 'diagnosticos', label: 'Diagnósticos o problemas clínicos', type: 'diagnoses', required: true, help: 'Código CIE-10 opcional' };
const prognosis: ClinicalField = { id: 'pronostico', label: 'Pronóstico', type: 'text', required: true };
const heredo: ClinicalField = { id: 'heredofamiliares', label: 'Antecedentes heredofamiliares', type: 'longtext' };
const ident: ClinicalSection = {
  id: 'ficha',
  title: 'Ficha de identificación',
  fields: [
    { id: 'ocupacion', label: 'Ocupación', type: 'text' },
    { id: 'estadoCivil', label: 'Estado civil', type: 'select', options: ['Soltero(a)', 'Casado(a)', 'Unión libre', 'Divorciado(a)', 'Viudo(a)'] },
    { id: 'escolaridad', label: 'Escolaridad', type: 'text' },
    { id: 'tipoSangre', label: 'Grupo sanguíneo', type: 'select', options: ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'Desconocido'] },
    { id: 'grupoEtnico', label: 'Grupo étnico (si aplica)', type: 'text' },
    { id: 'responsable', label: 'Responsable o tutor (si aplica)', type: 'text' },
  ],
};
const personales: ClinicalSection = {
  id: 'personales',
  title: 'Antecedentes personales',
  fields: [
    { id: 'patologicos', label: 'Personales patológicos (enfermedades, cirugías, hospitalizaciones, transfusiones, traumatismos)', type: 'longtext' },
    { id: 'alergias', label: 'Alergias', type: 'text' },
    { id: 'medicamentosActuales', label: 'Medicamentos actuales', type: 'text' },
    { id: 'tabaco', label: 'Tabaco', type: 'select', options: ['Nunca', 'Exfumador(a)', 'Fuma actualmente'] },
    { id: 'alcohol', label: 'Alcohol', type: 'select', options: ['No', 'Ocasional', 'Frecuente'] },
    { id: 'sustancias', label: 'Otras sustancias', type: 'text' },
    { id: 'noPatologicos', label: 'No patológicos (alimentación, actividad física, vivienda, vacunación)', type: 'longtext' },
  ],
};
const gyneco: ClinicalSection = {
  id: 'gineco',
  title: 'Antecedentes gineco-obstétricos (si aplica)',
  fields: [
    { id: 'menarca', label: 'Menarca (edad)', type: 'number' },
    { id: 'fum', label: 'Fecha de última menstruación', type: 'date' },
    { id: 'gestas', label: 'Gestas / partos / cesáreas / abortos', type: 'text', help: 'Ej. G2 P1 C1 A0' },
    { id: 'mpf', label: 'Método de planificación familiar', type: 'text' },
  ],
};
const medications = (required = false): ClinicalField => ({ id: 'medicamentos', label: 'Medicamentos (dosis, vía y periodicidad)', type: 'medications', required });

// ---- Templates ----
export const CLINICAL_TEMPLATES: Record<string, ClinicalTemplate> = {
  medical_history: {
    id: 'medical_history',
    kind: 'history',
    title: 'Historia clínica',
    norm: 'NOM-004-SSA3-2012, 6.1',
    sections: [
      ident,
      { id: 'heredo', title: 'Antecedentes heredofamiliares', fields: [heredo] },
      personales,
      gyneco,
      {
        id: 'padecimiento',
        title: 'Padecimiento actual',
        fields: [
          { id: 'padecimientoActual', label: 'Padecimiento actual (incluye tratamientos previos convencionales, alternativos y tradicionales)', type: 'longtext', required: true },
          { id: 'aparatos', label: 'Interrogatorio por aparatos y sistemas', type: 'longtext' },
        ],
      },
      {
        id: 'exploracion',
        title: 'Exploración física',
        fields: [
          { id: 'habitus', label: 'Habitus exterior', type: 'longtext' },
          vitals(true),
          { id: 'cabeza', label: 'Cabeza', type: 'text' },
          { id: 'cuello', label: 'Cuello', type: 'text' },
          { id: 'torax', label: 'Tórax', type: 'text' },
          { id: 'abdomen', label: 'Abdomen', type: 'text' },
          { id: 'miembros', label: 'Miembros', type: 'text' },
          { id: 'genitales', label: 'Genitales (si se exploran)', type: 'text' },
        ],
      },
      { id: 'estudios', title: 'Resultados de laboratorio, gabinete y otros', fields: [{ id: 'resultados', label: 'Resultados previos y actuales', type: 'longtext' }] },
      { id: 'diagnostico', title: 'Diagnóstico y pronóstico', fields: [diagnoses, prognosis] },
      { id: 'tratamiento', title: 'Indicación terapéutica', fields: [medications(), { id: 'indicaciones', label: 'Indicaciones', type: 'longtext', required: true }] },
    ],
  },
  medical_evolution: {
    id: 'medical_evolution',
    kind: 'evolution',
    title: 'Nota de evolución',
    norm: 'NOM-004-SSA3-2012, 6.2',
    sections: [
      {
        id: 'nota',
        title: 'Nota',
        fields: [
          { id: 'evolucion', label: 'Evolución y actualización del cuadro clínico', type: 'longtext', required: true },
          vitals(),
          { id: 'resultados', label: 'Resultados relevantes de estudios', type: 'longtext' },
          diagnoses,
          prognosis,
          medications(),
          { id: 'indicaciones', label: 'Tratamiento e indicaciones', type: 'longtext', required: true },
        ],
      },
    ],
  },
  dental_history: {
    id: 'dental_history',
    kind: 'history',
    title: 'Historia clínica estomatológica',
    norm: 'NOM-013-SSA2-2015',
    sections: [
      ident,
      { id: 'heredo', title: 'Antecedentes heredofamiliares', fields: [heredo] },
      personales,
      {
        id: 'padecimiento',
        title: 'Padecimiento actual',
        fields: [
          { id: 'motivo', label: 'Motivo de la consulta', type: 'text', required: true },
          { id: 'padecimientoActual', label: 'Padecimiento actual', type: 'longtext', required: true },
          { id: 'aparatos', label: 'Interrogatorio por aparatos y sistemas', type: 'longtext' },
        ],
      },
      { id: 'signosSec', title: 'Signos vitales', fields: [vitals(true)] },
      {
        id: 'exploracion',
        title: 'Exploración de cabeza, cuello y cavidad bucal',
        fields: [
          { id: 'cabezaCuello', label: 'Cabeza y cuello', type: 'text' },
          { id: 'atm', label: 'Articulación temporomandibular', type: 'text' },
          { id: 'tejidosBlandos', label: 'Tejidos blandos (labios, carrillos, lengua, paladar, piso de boca)', type: 'longtext' },
          { id: 'encias', label: 'Encías y periodonto', type: 'text' },
          { id: 'oclusion', label: 'Oclusión', type: 'text' },
          { id: 'higiene', label: 'Higiene bucal', type: 'select', options: ['Buena', 'Regular', 'Deficiente'] },
        ],
      },
      { id: 'odonto', title: 'Odontograma inicial', fields: [{ id: 'odontograma', label: 'Odontograma', type: 'odontogram' }] },
      { id: 'estudios', title: 'Auxiliares de diagnóstico', fields: [{ id: 'resultados', label: 'Radiografías y otros estudios', type: 'longtext' }] },
      { id: 'diagnostico', title: 'Diagnóstico, pronóstico y plan', fields: [diagnoses, prognosis, { id: 'plan', label: 'Plan de tratamiento', type: 'longtext', required: true }] },
    ],
  },
  dental_evolution: {
    id: 'dental_evolution',
    kind: 'evolution',
    title: 'Nota de evolución odontológica',
    norm: 'NOM-013-SSA2-2015',
    sections: [
      {
        id: 'nota',
        title: 'Nota',
        fields: [
          { id: 'procedimiento', label: 'Tratamiento realizado', type: 'longtext', required: true },
          { id: 'piezas', label: 'Piezas tratadas', type: 'text', help: 'Numeración FDI, ej. 16, 26' },
          { id: 'anestesia', label: 'Anestesia (tipo y cartuchos)', type: 'text' },
          { id: 'materiales', label: 'Materiales', type: 'text' },
          { id: 'odontograma', label: 'Odontograma actualizado', type: 'odontogram' },
          medications(),
          { id: 'indicaciones', label: 'Indicaciones', type: 'longtext' },
          { id: 'proxima', label: 'Próxima cita', type: 'text' },
        ],
      },
    ],
  },
  psychology_history: {
    id: 'psychology_history',
    kind: 'history',
    title: 'Historia clínica psicológica',
    norm: 'NOM-004-SSA3-2012, 5.16',
    sections: [
      ident,
      {
        id: 'motivo',
        title: 'Motivo de consulta',
        fields: [
          { id: 'motivo', label: 'Motivo de consulta (en palabras del paciente)', type: 'longtext', required: true },
          { id: 'historiaProblema', label: 'Historia del problema actual', type: 'longtext' },
          { id: 'tratamientosPrevios', label: 'Tratamientos psicológicos o psiquiátricos previos', type: 'longtext' },
        ],
      },
      {
        id: 'antecedentes',
        title: 'Antecedentes',
        fields: [
          heredo,
          { id: 'desarrollo', label: 'Historia personal y del desarrollo', type: 'longtext' },
          { id: 'familia', label: 'Dinámica familiar y red de apoyo', type: 'longtext' },
          { id: 'medicos', label: 'Antecedentes médicos y medicamentos', type: 'longtext' },
          { id: 'sustancias', label: 'Consumo de sustancias', type: 'text' },
        ],
      },
      {
        id: 'examen',
        title: 'Examen mental',
        fields: [
          { id: 'apariencia', label: 'Apariencia y conducta', type: 'text' },
          { id: 'animo', label: 'Estado de ánimo y afecto', type: 'text' },
          { id: 'pensamiento', label: 'Pensamiento (curso y contenido)', type: 'text' },
          { id: 'sensopercepcion', label: 'Sensopercepción', type: 'text' },
          { id: 'orientacion', label: 'Orientación, atención y memoria', type: 'text' },
          { id: 'juicio', label: 'Juicio e introspección', type: 'text' },
          { id: 'riesgo', label: 'Valoración de riesgo', type: 'longtext' },
        ],
      },
      { id: 'pruebas', title: 'Pruebas aplicadas', fields: [{ id: 'pruebas', label: 'Pruebas y resultados', type: 'longtext' }] },
      {
        id: 'diagnostico',
        title: 'Impresión diagnóstica y plan',
        fields: [diagnoses, prognosis, { id: 'plan', label: 'Plan terapéutico (enfoque, objetivos, frecuencia)', type: 'longtext', required: true }],
      },
    ],
  },
  psychology_session: {
    id: 'psychology_session',
    kind: 'evolution',
    title: 'Nota de sesión',
    norm: 'NOM-004-SSA3-2012, 5.16',
    sections: [
      {
        id: 'nota',
        title: 'Sesión',
        fields: [
          { id: 'objetivo', label: 'Objetivo de la sesión', type: 'text' },
          { id: 'desarrollo', label: 'Desarrollo e intervención', type: 'longtext', required: true },
          { id: 'observaciones', label: 'Observaciones clínicas (ánimo, afecto, riesgo)', type: 'longtext' },
          { id: 'tareas', label: 'Tareas o acuerdos', type: 'text' },
          { id: 'plan', label: 'Plan para la próxima sesión', type: 'text' },
        ],
      },
    ],
  },
  physio_history: {
    id: 'physio_history',
    kind: 'history',
    title: 'Valoración fisioterapéutica',
    norm: 'NOM-004-SSA3-2012, 5.16',
    sections: [
      ident,
      {
        id: 'motivo',
        title: 'Motivo y antecedentes',
        fields: [
          { id: 'motivo', label: 'Motivo de consulta', type: 'longtext', required: true },
          { id: 'diagnosticoMedico', label: 'Diagnóstico médico de envío (si hay)', type: 'text' },
          { id: 'antecedentes', label: 'Antecedentes (lesiones, cirugías, enfermedades)', type: 'longtext' },
          { id: 'actividad', label: 'Ocupación y actividad física', type: 'text' },
        ],
      },
      {
        id: 'dolor',
        title: 'Dolor',
        fields: [
          { id: 'eva', label: 'Intensidad (EVA 0–10)', type: 'pain' },
          { id: 'localizacion', label: 'Localización', type: 'text' },
          { id: 'tipo', label: 'Tipo y comportamiento', type: 'text' },
        ],
      },
      {
        id: 'exploracion',
        title: 'Exploración',
        fields: [
          vitals(),
          { id: 'postura', label: 'Postura', type: 'text' },
          { id: 'arcos', label: 'Arcos de movimiento', type: 'longtext' },
          { id: 'fuerza', label: 'Fuerza muscular (Daniels 0–5)', type: 'longtext' },
          { id: 'pruebas', label: 'Pruebas especiales', type: 'longtext' },
          { id: 'marcha', label: 'Marcha y funcionalidad', type: 'text' },
        ],
      },
      {
        id: 'plan',
        title: 'Diagnóstico y plan',
        fields: [
          { id: 'diagnosticoFisio', label: 'Diagnóstico fisioterapéutico', type: 'longtext', required: true },
          diagnoses,
          prognosis,
          { id: 'objetivos', label: 'Objetivos', type: 'longtext' },
          { id: 'plan', label: 'Plan de tratamiento (sesiones y técnicas)', type: 'longtext', required: true },
        ],
      },
    ],
  },
  physio_session: {
    id: 'physio_session',
    kind: 'evolution',
    title: 'Nota de sesión de fisioterapia',
    norm: 'NOM-004-SSA3-2012, 5.16',
    sections: [
      {
        id: 'nota',
        title: 'Sesión',
        fields: [
          { id: 'evaInicial', label: 'Dolor al llegar (EVA)', type: 'pain' },
          { id: 'tecnicas', label: 'Técnicas y modalidades aplicadas', type: 'longtext', required: true },
          { id: 'ejercicios', label: 'Ejercicios', type: 'longtext' },
          { id: 'evaFinal', label: 'Dolor al terminar (EVA)', type: 'pain' },
          { id: 'respuesta', label: 'Respuesta y evolución', type: 'longtext' },
          { id: 'casa', label: 'Indicaciones para casa', type: 'text' },
        ],
      },
    ],
  },
  nutrition_history: {
    id: 'nutrition_history',
    kind: 'history',
    title: 'Historia clínica nutricional',
    norm: 'NOM-004-SSA3-2012, 5.16',
    sections: [
      ident,
      {
        id: 'motivo',
        title: 'Motivo y antecedentes',
        fields: [
          { id: 'motivo', label: 'Motivo de consulta y objetivo', type: 'longtext', required: true },
          heredo,
          { id: 'patologicos', label: 'Antecedentes personales patológicos', type: 'longtext' },
          { id: 'medicamentos', label: 'Medicamentos y suplementos', type: 'text' },
          { id: 'alergias', label: 'Alergias e intolerancias alimentarias', type: 'text' },
        ],
      },
      {
        id: 'habitos',
        title: 'Hábitos',
        fields: [
          { id: 'actividad', label: 'Actividad física', type: 'text' },
          { id: 'agua', label: 'Consumo de agua (litros/día)', type: 'number' },
          { id: 'horarios', label: 'Horarios de comida y sueño', type: 'text' },
          { id: 'recordatorio', label: 'Recordatorio de 24 horas', type: 'longtext' },
        ],
      },
      { id: 'antropometria', title: 'Antropometría', fields: [{ id: 'medidas', label: 'Medidas', type: 'anthropometry', required: true }] },
      { id: 'bioquimicos', title: 'Datos bioquímicos', fields: [{ id: 'bioquimicos', label: 'Estudios de laboratorio', type: 'longtext' }] },
      {
        id: 'diagnostico',
        title: 'Diagnóstico y plan',
        fields: [
          { id: 'diagnosticoNutricio', label: 'Diagnóstico nutricional', type: 'longtext', required: true },
          prognosis,
          { id: 'plan', label: 'Plan de alimentación (kcal y distribución)', type: 'longtext', required: true },
          { id: 'metas', label: 'Metas', type: 'text' },
        ],
      },
    ],
  },
  nutrition_followup: {
    id: 'nutrition_followup',
    kind: 'evolution',
    title: 'Nota de seguimiento nutricional',
    norm: 'NOM-004-SSA3-2012, 5.16',
    sections: [
      {
        id: 'nota',
        title: 'Seguimiento',
        fields: [
          { id: 'medidas', label: 'Medidas', type: 'anthropometry', required: true },
          { id: 'adherencia', label: 'Apego al plan', type: 'select', options: ['Bueno', 'Regular', 'Bajo'] },
          { id: 'evolucion', label: 'Evolución y cambios', type: 'longtext', required: true },
          { id: 'ajustes', label: 'Ajustes al plan', type: 'longtext' },
        ],
      },
    ],
  },
  interconsult: {
    id: 'interconsult',
    kind: 'interconsult',
    title: 'Solicitud de interconsulta',
    norm: 'NOM-004-SSA3-2012, 6.3',
    sections: [
      {
        id: 'solicitud',
        title: 'Solicitud',
        fields: [
          { id: 'especialidad', label: 'Especialidad o médico consultado', type: 'text', required: true },
          { id: 'motivo', label: 'Motivo de la interconsulta', type: 'longtext', required: true },
          { id: 'resumen', label: 'Resumen del caso', type: 'longtext' },
          diagnoses,
        ],
      },
    ],
  },
  referral: {
    id: 'referral',
    kind: 'referral',
    title: 'Nota de referencia',
    norm: 'NOM-004-SSA3-2012, 6.4',
    sections: [
      {
        id: 'referencia',
        title: 'Referencia',
        fields: [
          { id: 'receptor', label: 'Establecimiento o profesional que recibe', type: 'text', required: true },
          { id: 'motivo', label: 'Motivo de envío', type: 'longtext', required: true },
          { id: 'impresion', label: 'Impresión diagnóstica', type: 'diagnoses', required: true },
          { id: 'terapeutica', label: 'Terapéutica empleada', type: 'longtext' },
          { id: 'resumen', label: 'Resumen clínico (padecimiento, evolución, estudios)', type: 'longtext', required: true },
        ],
      },
    ],
  },
  prescription: {
    id: 'prescription',
    kind: 'prescription',
    title: 'Receta',
    norm: 'Reglamento de Insumos para la Salud, art. 29',
    sections: [
      {
        id: 'receta',
        title: 'Receta',
        fields: [medications(true), { id: 'indicaciones', label: 'Indicaciones', type: 'longtext' }, { id: 'diagnostico', label: 'Diagnóstico', type: 'text' }],
      },
    ],
  },
  consent: {
    id: 'consent',
    kind: 'consent',
    title: 'Carta de consentimiento informado',
    norm: 'NOM-004-SSA3-2012, 10.1',
    sections: [
      {
        id: 'acto',
        title: 'Acto autorizado',
        fields: [
          { id: 'acto', label: 'Acto o procedimiento autorizado', type: 'longtext', required: true },
          { id: 'riesgos', label: 'Riesgos', type: 'longtext', required: true },
          { id: 'beneficios', label: 'Beneficios esperados', type: 'longtext', required: true },
          { id: 'contingencias', label: 'Autorizo atender contingencias y urgencias derivadas del acto', type: 'yesno', required: true },
        ],
      },
      { id: 'firmas', title: 'Firmas', fields: [{ id: 'firmas', label: 'Paciente (o representante), médico y dos testigos', type: 'signatures', required: true }] },
    ],
  },
  pediatric_visit: {
    id: 'pediatric_visit',
    kind: 'evolution',
    title: 'Consulta pediátrica (niño sano)',
    norm: 'NOM-004-SSA3-2012, 6.2; NOM-031-SSA2-1999',
    sections: [
      {
        id: 'crecimiento',
        title: 'Crecimiento',
        fields: [
          { id: 'medidas', label: 'Peso y talla', type: 'anthropometry', required: true },
          { id: 'perimetroCefalico', label: 'Perímetro cefálico', type: 'number', unit: 'cm' },
          vitals(),
        ],
      },
      {
        id: 'desarrollo',
        title: 'Desarrollo y prevención',
        fields: [
          { id: 'desarrollo', label: 'Desarrollo psicomotor (hitos)', type: 'longtext' },
          { id: 'alimentacion', label: 'Alimentación', type: 'select', options: ['Lactancia materna exclusiva', 'Lactancia mixta', 'Fórmula', 'Ablactación', 'Dieta familiar'] },
          { id: 'vacunas', label: 'Vacunas aplicadas hoy o pendientes (Cartilla Nacional de Salud)', type: 'longtext' },
          { id: 'tamiz', label: 'Tamiz neonatal, auditivo y visual', type: 'text' },
        ],
      },
      {
        id: 'nota',
        title: 'Nota',
        fields: [
          { id: 'evolucion', label: 'Padecimiento o motivo y exploración', type: 'longtext', required: true },
          diagnoses,
          prognosis,
          medications(),
          { id: 'indicaciones', label: 'Indicaciones y orientación a padres', type: 'longtext', required: true },
        ],
      },
    ],
  },
  prenatal_visit: {
    id: 'prenatal_visit',
    kind: 'evolution',
    title: 'Control prenatal',
    norm: 'NOM-004-SSA3-2012, 6.2; NOM-007-SSA2-2016',
    sections: [
      {
        id: 'embarazo',
        title: 'Embarazo',
        fields: [
          { id: 'fum', label: 'Fecha de última menstruación (FUM)', type: 'date', required: true },
          { id: 'sdg', label: 'Semanas de gestación (SDG)', type: 'text', help: 'Se calcula con la FUM' },
          { id: 'fpp', label: 'Fecha probable de parto (FPP)', type: 'date', help: 'Se calcula con la FUM' },
          { id: 'gestas', label: 'Gestas / partos / cesáreas / abortos', type: 'text' },
          { id: 'riesgo', label: 'Riesgo obstétrico', type: 'select', options: ['Bajo', 'Alto'] },
        ],
      },
      {
        id: 'exploracion',
        title: 'Exploración',
        fields: [
          vitals(true),
          { id: 'alturaUterina', label: 'Altura uterina', type: 'number', unit: 'cm' },
          { id: 'fcf', label: 'Frecuencia cardiaca fetal', type: 'number', unit: 'lpm' },
          { id: 'movimientos', label: 'Movimientos fetales presentes', type: 'yesno' },
          { id: 'edema', label: 'Edema', type: 'select', options: ['Sin edema', '+', '++', '+++'] },
          { id: 'alarma', label: 'Signos de alarma (sangrado, cefalea, visión borrosa, pérdida de líquido)', type: 'longtext' },
        ],
      },
      {
        id: 'nota',
        title: 'Nota',
        fields: [
          { id: 'evolucion', label: 'Evolución', type: 'longtext', required: true },
          { id: 'resultados', label: 'Estudios (BH, EGO, glucosa, VIH, VDRL, ultrasonido)', type: 'longtext' },
          diagnoses,
          prognosis,
          medications(),
          { id: 'indicaciones', label: 'Indicaciones y próxima cita', type: 'longtext', required: true },
        ],
      },
    ],
  },
  addendum: {
    id: 'addendum',
    kind: 'addendum',
    title: 'Nota aclaratoria',
    norm: 'NOM-004-SSA3-2012, 5.11',
    sections: [{ id: 'nota', title: 'Aclaración', fields: [{ id: 'texto', label: 'Aclaración o corrección', type: 'longtext', required: true }] }],
  },
};

/** Templates each health giro uses, in menu order (history first). */
export const CLINICAL_TEMPLATES_BY_TYPE: Record<string, string[]> = {
  medical: ['medical_history', 'medical_evolution', 'pediatric_visit', 'prenatal_visit', 'prescription', 'interconsult', 'referral', 'consent'],
  dental: ['dental_history', 'dental_evolution', 'prescription', 'referral', 'consent'],
  psychology: ['psychology_history', 'psychology_session', 'referral', 'consent'],
  physiotherapy: ['physio_history', 'physio_session', 'referral', 'consent'],
  nutrition: ['nutrition_history', 'nutrition_followup', 'referral'],
};
/**
 * Templates a business writes with: the ones of its giro plus its own (made in Configuración).
 */
export const clinicalTemplatesFor = (businessType: string, custom: CustomClinicalTemplate[] = []): ClinicalTemplate[] => [
  ...(CLINICAL_TEMPLATES_BY_TYPE[businessType] ?? []).map((id) => CLINICAL_TEMPLATES[id]!),
  ...custom.map((c) => customToTemplate(c, businessType)),
];
/** A template by id (built-in or the business's own), for reading or writing a document. */
export const clinicalTemplateById = (id: string, businessType: string, custom: CustomClinicalTemplate[] = []): ClinicalTemplate | null =>
  CLINICAL_TEMPLATES[id] ?? (custom.find((c) => c.id === id) ? customToTemplate(custom.find((c) => c.id === id)!, businessType) : null);

// ---- The business's own templates ----
export const CUSTOM_FIELD_TYPES = ['text', 'longtext', 'number', 'select', 'yesno', 'date', 'vitals', 'anthropometry', 'diagnoses', 'medications', 'pain'] as const;
export const customClinicalTemplateSchema = z.object({
  id: z.string().regex(/^custom_[a-z0-9]{4,24}$/),
  title: z.string().trim().min(2).max(80),
  kind: z.enum(['history', 'evolution']),
  fields: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,30}$/),
        label: z.string().trim().min(1).max(160),
        type: z.enum(CUSTOM_FIELD_TYPES),
        required: z.boolean().optional(),
        options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
        unit: z.string().trim().max(12).optional(),
      }),
    )
    .min(1)
    .max(40),
});
export type CustomClinicalTemplate = z.infer<typeof customClinicalTemplateSchema>;
export function customToTemplate(c: CustomClinicalTemplate, businessType: string): ClinicalTemplate {
  return { id: c.id, kind: c.kind, title: c.title, norm: clinicalNormFor(businessType), sections: [{ id: 'main', title: c.title, fields: c.fields }] };
}

/**
 * The template a saved document was written with. Documents from the business's own templates
 * carry a copy (`__template`), so they still read right if the template is later changed.
 */
export function noteTemplate(note: { template: string; content: Record<string, unknown> }, businessType: string, custom: CustomClinicalTemplate[] = []): ClinicalTemplate | null {
  const snap = note.content.__template as CustomClinicalTemplate | undefined;
  return CLINICAL_TEMPLATES[note.template] ?? (snap ? customToTemplate(snap, businessType) : clinicalTemplateById(note.template, businessType, custom));
}

/** Weeks of pregnancy and due date from the last period (Naegele: +280 days). */
export function pregnancyFromFum(fum: string, today = new Date()): { sdg: string; fpp: string } | null {
  const start = new Date(`${fum}T12:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  const days = Math.floor((today.getTime() - start.getTime()) / 864e5);
  if (days < 0 || days > 320) return null;
  const fpp = new Date(start.getTime() + 280 * 864e5).toISOString().slice(0, 10);
  return { sdg: `${Math.floor(days / 7)}.${days % 7}`, fpp };
}
export const clinicalNormFor = (businessType: string) => (businessType === 'dental' ? 'NOM-013-SSA2-2015' : 'NOM-004-SSA3-2012');

/** First missing required field (label), or null. */
export function missingRequired(t: ClinicalTemplate, content: ClinicalContent): string | null {
  for (const s of t.sections) {
    for (const f of s.fields) {
      if (!f.required) continue;
      const v = content[f.id];
      const empty =
        v == null ||
        v === '' ||
        (Array.isArray(v) && v.filter((x) => (typeof x === 'object' && x ? Object.values(x).some((y) => y !== '' && y != null) : Boolean(x))).length === 0) ||
        (f.type === 'vitals' && typeof v === 'object' && !Object.values(v as object).some((x) => x !== '' && x != null)) ||
        (f.type === 'anthropometry' && typeof v === 'object' && !(v as Anthropometry).peso) ||
        (f.type === 'signatures' && !((v as ConsentSignatures).patient?.image && (v as ConsentSignatures).doctor?.image && (v as ConsentSignatures).witness1?.image && (v as ConsentSignatures).witness2?.image));
      if (empty) return f.label;
    }
  }
  return null;
}

// ---- API shapes ----
export const sexValues = ['F', 'M', 'X'] as const;
export const clinicalNoteInputSchema = z.object({
  template: z.string().min(2).max(40),
  appointmentId: z.string().uuid().nullable().optional(),
  content: z.record(z.string(), z.unknown()),
});
export const clinicalSignSchema = z.object({ password: z.string().min(1).max(200) });
export const clinicalAddendumSchema = z.object({ text: z.string().trim().min(2).max(5000), password: z.string().min(1).max(200) });
export const professionalSchema = z.object({
  license: z.string().trim().max(20).nullable().optional(),
  institution: z.string().trim().max(160).nullable().optional(),
  specialty: z.string().trim().max(120).nullable().optional(),
  specialtyLicense: z.string().trim().max(20).nullable().optional(),
});
export type Professional = z.infer<typeof professionalSchema>;

export interface ClinicalAuthor {
  name: string;
  license: string | null;
  institution: string | null;
  specialty: string | null;
  specialtyLicense: string | null;
}
export interface ClinicalNoteDto {
  id: string;
  template: string;
  kind: ClinicalKind;
  title: string;
  appointmentId: string | null;
  appointmentAt: string | null;
  serviceName: string | null;
  content: ClinicalContent;
  status: 'draft' | 'signed';
  author: ClinicalAuthor | null;
  authorId: string | null;
  signedAt: string | null;
  /** SHA-256 of what was signed */
  contentHash: string | null;
  /** For a nota aclaratoria: the note it clarifies */
  amendsId: string | null;
  /** Shown to the patient in their portal since */
  sharedAt: string | null;
  /** Signed prescriptions: public page to verify it (/receta/<token>), for the QR and to send it */
  verifyPath: string | null;
  createdAt: string;
}
export const STUDY_KINDS = ['lab', 'imaging', 'document'] as const;
export type StudyKind = (typeof STUDY_KINDS)[number];
/** A study (lab result, X-ray, PDF) attached to the record. */
export interface StudyDto {
  id: string;
  kind: StudyKind;
  title: string | null;
  contentType: string;
  sizeBytes: number;
  sharedAt: string | null;
  createdAt: string;
}
/** Up to 10 MB: PDF, JPG, PNG or WebP. */
export const STUDY_MAX_BYTES = 10 * 1024 * 1024;

/** What a patient sees in their portal. */
export interface PortalDto {
  business: { name: string; slug: string; phone: string | null; address: string | null; logoUrl: string | null; businessType: string };
  patient: { name: string };
  appointments: { id: string; startsAt: string; status: string; serviceName: string | null; resourceName: string | null; managePath: string }[];
  documents: ClinicalNoteDto[];
  studies: (StudyDto & { url: string })[];
  /** New session token when the current one is getting old (store it) */
  renewedToken: string | null;
}
/** Public check of a signed prescription. */
export interface PrescriptionCheckDto {
  clinic: { name: string; legalName: string | null; healthLicense: string | null; address: string | null; phone: string | null };
  doctor: ClinicalAuthor;
  patient: { name: string; age: number | null };
  signedAt: string;
  contentHash: string;
  content: ClinicalContent;
}
export interface ClinicalPatientDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  sex: (typeof sexValues)[number] | null;
  address: string | null;
  curp: string | null;
  archived: boolean;
  /** Allergies from the record and the latest signed history, for the prescription check */
  allergies: string | null;
}
export interface ClinicalRecordDto {
  norm: string;
  patient: ClinicalPatientDto;
  clinic: { name: string; legalName: string | null; healthLicense: string | null; address: string | null; phone: string | null };
  notes: ClinicalNoteDto[];
  studies: StudyDto[];
  /** False until the private file storage is connected */
  studiesEnabled: boolean;
  /** Latest odontogram (dental) */
  odontogram: Odontogram | null;
}
export interface ClinicalLogDto {
  userName: string;
  action: string;
  detail: string | null;
  createdAt: string;
}

/** Age in years on a date (YYYY-MM-DD) */
export function ageOn(birthday: string | null | undefined, today = new Date().toISOString().slice(0, 10)): number | null {
  if (!birthday) return null;
  const [y, m, d] = birthday.slice(0, 10).split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}
