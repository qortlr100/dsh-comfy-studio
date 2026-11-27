// Host scenario that waits for a service nobody provides, to see the harness time out.

export const SERVICE = "csNoSuchService";

export const inject = [SERVICE];

export default function missingService(): never {
  throw new Error("unreachable: the service never appears");
}
