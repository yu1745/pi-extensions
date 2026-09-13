import type { ProviderConfig } from "../types.js";
import { antigravityProviderConfig } from "./antigravity.js";
import { codexProviderConfig } from "./codex.js";
import { commandCodeProviderConfig } from "./commandcode.js";
import { deepseekProviderConfig } from "./deepseek.js";
import { glmProviderConfig } from "./glm.js";
import { minimaxProviderConfig } from "./minimax.js";

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
