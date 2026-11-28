import { normalizeCareerLink } from './careers-links.ts';

export const MAX_CAREER_CV_BYTES = 5 * 1024 * 1024;

export function careerCvError(file: File | null): string {
  if (!file) return 'Choose a CV to continue.';
  if (!/\.(pdf|docx?)$/i.test(file.name)) return 'Choose a PDF, DOC or DOCX file.';
  if (!file.size) return 'Your CV is empty. Choose a different file.';
  if (file.size > MAX_CAREER_CV_BYTES) return 'Your CV must be 5 MB or smaller.';
  return '';
}

type SaveResult = { success: boolean; message: string };

export async function saveCareerForm(
  data: FormData,
  submit: (careerId: string, data: FormData) => Promise<SaveResult>
): Promise<SaveResult> {
  const retryMessage = 'We could not save your application. Please try again.';
  try {
    const result = await submit(String(data.get('careerId')), data);
    return { success: result.success, message: result.message || retryMessage };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error && error.message ? error.message : retryMessage,
    };
  }
}

export function careerPhoneNumber(value: string): string {
  const digits = value.replace(/[\s()-]/g, '');
  return /^(?:\+[1-9]\d{6,14}|(?:0|254)[17]\d{8})$/.test(digits) ? digits : '';
}

export function isCareerLink(value: string): boolean {
  return normalizeCareerLink(value) !== null;
}
