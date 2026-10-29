export const NAVIGATION: readonly ['HOME_URL', 'FLEET_URL', 'MODEL_ROUTER_URL'];
export function validateNavigationURL(name: string, value: unknown): string;
export function validateHomeURL(value: unknown): string;
export function navigationFromConfig(path?: string | URL): Record<'HOME_URL' | 'FLEET_URL' | 'MODEL_ROUTER_URL', string>;
export function homeURLFromConfig(path?: string | URL): string;
