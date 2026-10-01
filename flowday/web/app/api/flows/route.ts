import { mutateFlow, getFlowState } from "@/features/flow/services/flows-route-service";
import {
  readJsonBody,
  serviceJson,
} from "@/lib/server/route-helpers";

export async function GET() {
  return serviceJson(getFlowState());
}

export async function PUT(request: Request) {
  return serviceJson(mutateFlow(await readJsonBody<unknown>(request)));
}
