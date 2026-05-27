import {
  call_rpc as inner_call_rpc,
  Request,
  RequestResponse,
  RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";

// Serializes standard RPC calls AND custom RPC calls so they never overlap on
// the transport.  Custom callers use queueCustomRpc instead of call_rpc.
let rpcQueue: Promise<unknown> = Promise.resolve();

function queue<T>(fn: () => Promise<T>): Promise<T> {
  const p = rpcQueue.then(fn);
  rpcQueue = p.then(
    () => {},
    () => {},
  );
  return p;
}

export async function call_rpc(
  conn: RpcConnection,
  req: Omit<Request, "requestId">
): Promise<RequestResponse> {
  return queue(async () => {
    console.log("RPC Request", req);
    return inner_call_rpc(conn, req)
      .then((r) => {
        console.log("RPC Response", r);
        return r;
      })
      .catch((e) => {
        console.error("RPC Error", e);
        return e;
      });
  });
}

