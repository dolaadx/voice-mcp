export async function load(url, context, nextLoad) {
  if (url === "cloudflare:workers") {
    return {
      format: "module",
      shortCircuit: true,
      source: `
        export class DurableObject {}
        export class RpcTarget {}
        export class WorkflowEntrypoint {}
        export const exports = {};
      `,
    };
  }
  if (url === "cloudflare:email") {
    return {
      format: "module",
      shortCircuit: true,
      source: "export class EmailMessage {}",
    };
  }
  return nextLoad(url, context);
}
