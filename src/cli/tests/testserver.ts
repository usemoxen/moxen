/**
 * The server a test file's CLI subprocesses start at its own endpoint
 * (`./setup.ts`): stopped when the file is done, or sooner by a test that
 * must delete a folder it holds open (Windows refuses to delete a file a
 * live process holds).
 */
import { probe } from "../../server/transport/endpoint.js";

export async function stopTestServer(endpoint: string | undefined = process.env.MOXEN_SERVER_ENDPOINT): Promise<void> {
  if (endpoint === undefined || !(await probe(endpoint))) return;
  const { RemoteConnection } = await import("../../server/transport/remote.js");
  const connection = await RemoteConnection.connect(endpoint, { reconnect: false });
  await connection.shutdownServer().catch(() => undefined);
  await connection.close();
  // Gone once the endpoint stops answering: its files are released by then.
  for (let attempt = 0; attempt < 50 && (await probe(endpoint)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
