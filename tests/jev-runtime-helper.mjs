/** Native Pi >=1.0 setup for opt-in, live experiments. Never parses or writes credentials. */
import { createRequire } from "node:module";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

// Resolve Pi's TypeScript loader without depending on a machine-specific global install.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
export const jiti = createJiti(import.meta.url);

export async function createExperimentJev() {
  const { createJevClassifier } = await jiti.import("../extensions/shared/jev/runtime.ts");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const modelRegistry = new ModelRegistry(runtime);
  // Classification resolves typesafe credentials through Pi at request time.
  return createJevClassifier({ modelRegistry });
}
