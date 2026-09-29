/**
 * The Durable Object class this script hosted while it was the Python Worker. Cloudflare refuses a
 * deleted_classes migration while the live version still binds the class (error 10061), so this
 * release keeps it as an empty class and a gateway-only release deletes it (docs/gateway-contract.md §6.6).
 * Nothing binds it any more; an alarm left over from the old implementation clears its storage.
 * A plain class (not `extends DurableObject`) keeps `cloudflare:workers` out of the unit tests.
 */
export class TodofyCoordinator {
  constructor(private readonly state: DurableObjectState) {}

  fetch(): Response {
    return new Response(null, { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}
