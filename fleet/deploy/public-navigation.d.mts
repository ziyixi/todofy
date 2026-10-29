export const NAVIGATION: readonly ['HOME_URL', 'NEWSLETTER_URL'];
export function validateNavigationURL(name: string, value: unknown): string;
export function validateHomeURL(value: unknown): string;
export function navigationFromConfig(path?: string | URL): Record<'HOME_URL' | 'NEWSLETTER_URL', string>;
export function homeURLFromConfig(path?: string | URL): string;
