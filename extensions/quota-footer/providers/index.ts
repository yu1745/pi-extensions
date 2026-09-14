import type { ProviderConfig } from "../types.ts";
import { antigravityProviderConfig } from "./antigravity.ts";
import { codexProviderConfig } from "./codex.ts";
import { commandCodeProviderConfig } from "./commandcode.ts";
import { deepseekProviderConfig } from "./deepseek.ts";
import { glmProviderConfig } from "./glm.ts";
import { minimaxProviderConfig } from "./minimax.ts";

export const CONFIGS: Record<string, ProviderConfig> = {
	deepseek: deepseekProviderConfig,
	"zai-coding-cn": glmProviderConfig,
	"minimax-cn": minimaxProviderConfig,
	"openai-codex": codexProviderConfig,
	antigravity: antigravityProviderConfig,
	commandcode: commandCodeProviderConfig,
};

export {
	antigravityProviderConfig,
	codexProviderConfig,
	commandCodeProviderConfig,
	deepseekProviderConfig,
	glmProviderConfig,
	minimaxProviderConfig,
};
