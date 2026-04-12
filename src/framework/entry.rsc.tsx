import {
	renderToReadableStream,
	createTemporaryReferenceSet,
	decodeReply,
	loadServerAction,
	decodeAction,
	decodeFormState,
} from "@vitejs/plugin-rsc/rsc";
import type { ReactFormState } from "react-dom/client";
import { Root } from "../app/root.tsx";
import { parseRenderRequest } from "./request.tsx";
import { runWithRequestAsync } from "./context.ts";

export type RscPayload = {
	root: React.ReactNode;
	returnValue?: { ok: boolean; data: unknown };
	formState?: ReactFormState;
};

export default { fetch: handler };

async function handler(request: Request): Promise<Response> {
	const renderRequest = parseRenderRequest(request);

	const { result: response, cookies } = await runWithRequestAsync(
		renderRequest.request,
		() => handleRequest(renderRequest),
	);

	// Apply Set-Cookie headers from server actions/components
	for (const cookie of cookies) {
		response.headers.append("set-cookie", cookie);
	}

	return response;
}

async function handleRequest(renderRequest: ReturnType<typeof parseRenderRequest>): Promise<Response> {
	const request = renderRequest.request;

	let returnValue: RscPayload["returnValue"] | undefined;
	let formState: ReactFormState | undefined;
	let temporaryReferences: unknown | undefined;
	let actionStatus: number | undefined;

	if (renderRequest.isAction === true) {
		if (renderRequest.actionId) {
			const contentType = request.headers.get("content-type");
			const body = contentType?.startsWith("multipart/form-data")
				? await request.formData()
				: await request.text();
			temporaryReferences = createTemporaryReferenceSet();
			const args = await decodeReply(body, { temporaryReferences });
			const action = await loadServerAction(renderRequest.actionId);
			try {
				const data = await action.apply(null, args);
				returnValue = { ok: true, data };
			} catch (e) {
				returnValue = { ok: false, data: e };
				actionStatus = 500;
			}
		} else {
			const formData = await request.formData();
			const decodedAction = await decodeAction(formData);
			try {
				const result = await decodedAction();
				formState = await decodeFormState(result, formData);
			} catch {
				return new Response("Internal Server Error", { status: 500 });
			}
		}
	}

	// If the action returned invalidated sections, filter the re-render
	// so the server only renders those sections (minimal GraphQL queries).
	// The client SectionListClient merges fresh sections with its cache.
	if (returnValue?.ok && returnValue.data &&
		typeof returnValue.data === "object" &&
		Array.isArray((returnValue.data as any).invalidate)) {
		const invalidate = (returnValue.data as any).invalidate as string[];
		if (invalidate.length > 0) {
			renderRequest.url.searchParams.set("sections", invalidate.join(","));
		}
	}

	const rscPayload: RscPayload = {
		root: <Root url={renderRequest.url} />,
		formState,
		returnValue,
	};
	const rscStream = renderToReadableStream<RscPayload>(rscPayload, {
		temporaryReferences,
	});

	if (renderRequest.isRsc) {
		return new Response(rscStream, {
			status: actionStatus,
			headers: { "content-type": "text/x-component;charset=utf-8" },
		});
	}

	const ssrEntryModule = await import.meta.viteRsc.loadModule<
		typeof import("./entry.ssr.tsx")
	>("ssr", "index");
	const ssrResult = await ssrEntryModule.renderHTML(rscStream, {
		formState,
		debugNojs: renderRequest.url.searchParams.has("__nojs"),
	});

	return new Response(ssrResult.stream, {
		status: ssrResult.status,
		headers: { "Content-type": "text/html" },
	});
}

if (import.meta.hot) {
	import.meta.hot.accept();
}
