/** Buffered service HTTP ports shared by native fetch and the jitless transport.
 * These services do not require multipart forms, blobs, cloning or streaming uploads.
 */
export type ServiceHttpRequest = Pick<Request, "url" | "method" | "headers" | "signal" | "text" | "arrayBuffer">;
export type ServiceHttpResponse = Pick<
	Response,
	"ok" | "status" | "statusText" | "headers" | "text" | "json" | "arrayBuffer" | "body"
>;
export type ServiceHttpFetch = (input: string | URL, init?: RequestInit) => Promise<ServiceHttpResponse>;
