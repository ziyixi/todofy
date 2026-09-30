/**
 * The method names contracts/ops-v1/ops-v1.ts declares for an app: `interface <name> ... { ... }` plus
 * its `OpsCommon<S>` base, parsed from the file's source. Shared by the unit tests (the dashboard calls
 * only these) and the workerd harness (the stub apps expose exactly these).
 */
export function declaredMethods(source: string, name: 'MailHeroOps' | 'TodofyOps' | 'LabOps'): string[] {
  const block = (interfaceName: string): string => {
    const match = new RegExp(`export interface ${interfaceName}[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
    if (!match?.[1]) throw new Error(`interface ${interfaceName} not found`);
    return match[1];
  };
  const methods = (body: string): string[] => [...body.matchAll(/^\s+([a-zA-Z]+)\(/gm)].map((m) => m[1] ?? '');
  return [...methods(block('OpsCommon<S>')), ...methods(block(name))].sort();
}
