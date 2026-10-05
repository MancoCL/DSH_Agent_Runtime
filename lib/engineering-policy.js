/**
 * 工程质量策略：把 `assets/ENGINEERING_POLICY.md` 读出来交给审查者。
 *
 * @module dsh-gac-runtime/engineering-policy
 *
 * 适配计划 §8 对这一项的处置是「原文保留，纳入插件资源，作为 Reviewer 的 system prompt 素材」。
 * 因此这里**不做任何改写**：资源文件是从原运行时逐字搬来的（同一个 SHA-256），本模块只负责
 * 把它读出来。改写一份策略文本等于制造第二个版本，而两个版本里的那一份才是模型读到的。
 *
 * 读不到时返回空串而不是抛错：审查者的提示词少一段策略，比整个审查节点跑不起来轻。但**原因
 * 要留下来**——一段静默缺席的策略素材会让「审查按工程质量策略做了」变成一句无从核对的话。
 *
 * 策略文本里的旧运行时代称（`PROTOCOL.md`、`.claude/project/`）按「原文保留」的口径保持原样：
 * 它们是这份策略的来源标注，改掉就不再是原文；本模块的文档负责说明它的来处与适用范围。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 资源文件相对本模块的路径。 */
export const POLICY_ASSET_PATH = '../assets/ENGINEERING_POLICY.md'

/** 读到的策略文本缓存，避免每个节点都去读一次盘。 */
let cached

/**
 * 读出工程质量策略。
 *
 * @returns {Readonly<{text: string, path: string, reason?: string}>} `text` 读不到时为空串，
 *   同时给出 `reason`。
 */
export function readEngineeringPolicy() {
  if (cached !== undefined) return cached
  let path = POLICY_ASSET_PATH
  try {
    path = fileURLToPath(new URL(POLICY_ASSET_PATH, import.meta.url))
    cached = Object.freeze({ text: readFileSync(path, 'utf8'), path })
  } catch (error) {
    cached = Object.freeze({
      text: '',
      path,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  return cached
}
