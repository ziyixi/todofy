import { FleetUiService } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import { createHttpClient } from '@ziyixi/proto/http-client';
export const client = createHttpClient(FleetUiService, (call) => fetch(call.url, { method: call.httpMethod, body: call.body, credentials: 'same-origin', redirect: 'error' }));
