import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import es from './es.json';

/**
 * Health businesses (médico, dental, psicología, fisioterapia, nutrición) say "paciente" instead
 * of "cliente" everywhere in the app; turned on from the session (lib/auth).
 */
let patients = false;
const swap: [RegExp, string][] = [
  [/\bClientes\b/g, 'Pacientes'],
  [/\bclientes\b/g, 'pacientes'],
  [/\bCliente\b/g, 'Paciente'],
  [/\bcliente\b/g, 'paciente'],
  [/\bCustomers\b/g, 'Patients'],
  [/\bcustomers\b/g, 'patients'],
  [/\bCustomer\b/g, 'Patient'],
  [/\bcustomer\b/g, 'patient'],
];
export function setPatientWords(on: boolean) {
  if (patients === on) return;
  patients = on;
  // Re-render translated text with the new word.
  void i18n.changeLanguage(i18n.language);
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .use({
    type: 'postProcessor',
    name: 'patients',
    process: (value: string) => (patients ? swap.reduce((v, [re, to]) => v.replace(re, to), value) : value),
  })
  .init({
    postProcess: ['patients'],
    resources: { es: { translation: es }, en: { translation: en } },
    fallbackLng: 'es',
    supportedLngs: ['es', 'en'],
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], lookupLocalStorage: 'agenda.lang' },
  });

i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
