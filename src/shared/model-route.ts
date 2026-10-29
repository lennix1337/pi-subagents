import { splitKnownThinkingSuffix, splitProviderModel } from "./model-info.ts";

/**
 * Ask the parent's account manager (pi-multi-account) which model a child should launch on.
 *
 * Children run without account failover of their own, so a child pinned to a spent account
 * dies on its first request even after the parent session has moved to a ready one. The root
 * answers synchronously on the shared extension bus by filling `result`; no `result` means no
 * live root answered (extension absent, failover disabled), and the model stays as configured.
 */
export const MODEL_ROUTE_REQUEST_EVENT = "pi:model-route:request:v1";

type RouteRef = { provider: string; id: string };
type RouteResult = { action: "keep"; reason?: string } | { action: "route"; model: RouteRef; reason: string };
type Emit = (name: string, payload: unknown) => void;

export interface LaunchModelRoute {
	/** The model to launch on, with the original thinking suffix. */
	model: string;
	/** The configured model it replaces. */
	from: string;
	reason: string;
}

let emit: Emit | undefined;

/** Bind routing to this runtime's bus; the returned function unbinds it if still current. */
export function installModelRouteBus(events: { emit: Emit }): () => void {
	const own: Emit = (name, payload) => events.emit(name, payload);
	emit = own;
	return () => {
		if (emit === own) emit = undefined;
	};
}

function isRef(value: unknown): value is RouteRef {
	const ref = value as RouteRef | undefined;
	return typeof ref?.provider === "string" && ref.provider.length > 0 && typeof ref.id === "string" && ref.id.length > 0;
}

/** The replacement for `model` when its account cannot serve a launch now, else undefined. */
export function routeLaunchModel(model: string, purpose = "subagent"): LaunchModelRoute | undefined {
	if (!emit) return undefined;
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
	const asked = splitProviderModel(baseModel);
	if (!asked) return undefined;
	const request: { version: 1; purpose: string; model: RouteRef; result?: RouteResult } = { version: 1, purpose, model: asked };
	try {
		emit(MODEL_ROUTE_REQUEST_EVENT, request);
	} catch {
		return undefined;
	}
	const result = request.result;
	if (result?.action !== "route" || !isRef(result.model)) return undefined;
	const routed = `${result.model.provider}/${result.model.id}`;
	if (routed === baseModel) return undefined;
	return { model: `${routed}${thinkingSuffix ?? ""}`, from: model, reason: typeof result.reason === "string" ? result.reason : "" };
}
