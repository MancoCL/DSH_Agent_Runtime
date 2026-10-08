/**
 * 构建者的写范围分类：软件构建者与测试构建者是**同一个语义角色**，靠写路径区分。
 *
 * @module dsh-gac-runtime/builder-scope
 *
 * 为什么不再加一个 `test_implementation` 角色
 * -------------------------------------------
 * 软件构建者与测试构建者要做的事完全相同——照着一份已批准的设计写代码，交回一份可验证的产物。
 * 它们的不同只在**能碰哪些路径**：一个只能改产品代码，一个只能改测试基线。角色词表里多一个
 * `test_implementation` 会把「同一件事」拆成两套结果契约、两套工具面、两套门禁，而真正需要分开的
 * 那一条——写路径——在角色表里根本表达不出来。
 *
 * 因此判据取自工程适配器声明的 `authority.test_paths`，而不是角色的名字：路径是计划里唯一可核对的
 * 事实，角色名是推断出来的。适配器没声明 `test_paths` 时这一层**完全不管**（返回 `unspecified`），
 * 于是已有工程的行为一字不变。
 *
 * 为什么「跨两类的写范围」必须被拒绝
 * ---------------------------------
 * 一个节点同时声明 `src/` 与 `test/`，就等于同一个人既写实现又写测试——那正是「测试验证的是实现
 * 符合预期」这条推理被自己废掉的地方：两边由同一次推理产出，测试会照着实现的形状写，于是它验证的
 * 是「实现和它自己一致」，而不是「实现符合需求」。拒绝它比给它分类更诚实：分类只能说出它是哪一类，
 * 而它本来就是两件事混在一个节点里。
 *
 * 依赖方向：本模块是纯函数，只读作用域语义（`lib/claims.js`）与角色判据（`lib/role-tools.js`），
 * 不碰磁盘、不碰工具管道。
 */

import { containedIn, findScopeOverlap, scopePrefix } from './claims.js'
import { semanticRoleOf } from './role-tools.js'

/** 每次拒绝都携带的结构化错误码。 */
export const BUILDER_CODES = Object.freeze({
  SCOPE_CLASS_MIXED: 'GAC_BUILDER_SCOPE_MIXED',
})

/** 一个实现节点的写范围属于哪一类构建者。 */
export const BUILDER_KINDS = Object.freeze({
  /** 只写测试路径之内。 */
  TEST: 'test',
  /** 完全不碰测试路径。 */
  SOFTWARE: 'software',
  /** 跨了两类——拒绝，而不是给它挑一边。 */
  MIXED: 'mixed',
  /** 适配器没声明测试路径，或节点本来就不写文件：这一层不管。 */
  UNSPECIFIED: 'unspecified',
})

/**
 * 取一个前缀；条目本身非法（空串、非字符串）时返回 `undefined`。
 *
 * `scopePrefix` 对空条目直接抛 `TypeError`，而这里要做的是**分类**：一个读不出前缀的条目不该让
 * 整次分类崩掉，它该被判成「说不出属于哪一类」——那会走 `spanning` 那条路，最终结果是拒绝。
 *
 * @param {unknown} entry
 * @returns {string|undefined}
 */
function safePrefix(entry) {
  try {
    return scopePrefix(/** @type {string} */ (entry))
  } catch {
    return undefined
  }
}

/**
 * 一个写范围属于哪一类构建者。
 *
 * 逐条分类后汇总，判定跨类有**两条**来源，缺一条就会漏：
 *
 *  1. **一条条目自己就跨了**（`spanning`）：它与测试路径相交，却不落在它之内。整仓写范围
 *     （`.`、`*`）是典型——它既在改产品、又在改测试。
 *  2. **两类条目同时出现**（`test` 与 `software` 都非空）：一条 `test/` 加一条 `src/` 看起来
 *     每条都很干净，但它们是**同一次推理**写出来的两份产物，于是测试会照着实现的形状写。
 *     只看 `spanning` 会把这种节点判成「测试构建者」，恰好放过要拦的那一种。
 *
 * @param {readonly string[]} writeScope
 * @param {readonly string[]} testPaths
 * @returns {{kind: string, test: string[], software: string[], spanning: string[]}}
 */
export function writeScopeClass(writeScope, testPaths) {
  const scope = Array.isArray(writeScope) ? writeScope : []
  const tests = Array.isArray(testPaths) ? testPaths : []
  if (tests.length === 0 || scope.length === 0) {
    return { kind: BUILDER_KINDS.UNSPECIFIED, test: [], software: [], spanning: [] }
  }
  // 读不出前缀的测试路径不参与判定：`findScopeOverlap` 对它会抛，而一个写坏的声明不该让
  // 「谁写测试」这件事变成一次崩溃。适配器侧已经保证它是非空字符串数组（`lib/project.js`），
  // 这里兜的是调用方。
  const usableTests = tests.filter((entry) => safePrefix(entry) !== undefined)

  const test = []
  const software = []
  const spanning = []
  for (const entry of scope) {
    if (safePrefix(entry) === undefined) {
      // 条目本身读不出前缀（空串、非字符串）。它既不能说落在测试路径之内，也不能说完全不碰
      // 测试路径——判成跨类，让上层拒绝。失败方向必须是拒绝，而不是「分类不出来就放过」。
      spanning.push(entry)
      continue
    }
    if (containedIn(entry, usableTests)) test.push(entry)
    else if (usableTests.length > 0 && findScopeOverlap([entry], usableTests).conflict) spanning.push(entry)
    else software.push(entry)
  }

  const kind = spanning.length > 0 || (test.length > 0 && software.length > 0)
    ? BUILDER_KINDS.MIXED
    : (test.length > 0 ? BUILDER_KINDS.TEST : BUILDER_KINDS.SOFTWARE)
  return { kind, test, software, spanning }
}

/**
 * 从工程适配器里取测试路径声明。
 *
 * 读的是**归一之后**的字段（`lib/project.js` 已经保证它一定是字符串数组）：这里再兜一层不是
 * 为了防适配器，而是为了防调用方——一个没接线好的 `adapterFor` 会让这一层读到 `undefined`，
 * 而「没声明」与「读不到」在这一层的处理恰好相同（都不管），所以返回空数组是安全的。
 *
 * @param {object} [adapter]
 * @returns {readonly string[]}
 */
export function testPathsOf(adapter) {
  const declared = adapter?.authority?.test_paths
  return Array.isArray(declared) ? declared : []
}

/**
 * 找出写范围跨了产品与测试两类的**实现节点**。
 *
 * 只审实现节点：设计角色产出的是设计产物、验证与复核角色不写产品文件，它们的写范围跨不跨类
 * 不改变「谁写实现、谁写测试」这件事。适配器没声明 `test_paths` 时返回空数组——这一层是**声明之后
 * 才生效**的约束，不是运行时替工程决定哪些路径算测试。
 *
 * @param {object} task - 已编译的任务对象。
 * @param {readonly string[]} testPaths
 * @returns {Array<{node_id: string, test: string[], software: string[], spanning: string[]}>}
 */
export function mixedScopeNodes(task, testPaths) {
  const tests = Array.isArray(testPaths) ? testPaths : []
  if (tests.length === 0) return []

  const offenders = []
  for (const node of task?.nodes?.values?.() ?? []) {
    if (semanticRoleOf(node) !== 'implementation') continue
    const verdict = writeScopeClass(node.write_scope, tests)
    if (verdict.kind === BUILDER_KINDS.MIXED) {
      offenders.push({ node_id: node.id, ...verdict })
    }
  }
  return offenders
}

/**
 * 把一批跨类节点说成一段人话，用于拒绝信息。
 *
 * 跨类有两条来源，措辞必须跟着分开——否则会出现「写范围里有 既不在测试路径 […] 之内」这种
 * 空了一截的话（`['src/', 'test/']` 每一条都很干净，跨的是**两条合起来**这一件事）。逐条点出
 * 是哪条路径，是因为读的人要据此把节点拆成两个，而拆的依据正是那条路径。
 *
 * @param {readonly object[]} offenders
 * @param {readonly string[]} testPaths
 * @returns {string}
 */
export function describeMixedScope(offenders, testPaths) {
  const declared = testPaths.length === 0 ? '（未声明）' : `[${testPaths.join(', ')}]`
  return offenders
    .map((entry) => {
      if (entry.spanning.length > 0) {
        return `节点 ${entry.node_id} 的写范围里有 ${entry.spanning.join('、')}`
          + `既不在测试路径 ${declared} 之内、又与它相交`
      }
      return `节点 ${entry.node_id} 的写范围同时含产品路径 ${entry.software.join('、')} `
        + `与测试路径 ${entry.test.join('、')}——两类产物由同一次推理写出`
    })
    .join('；')
}
