/**
 * 示例陷阱定义 —— **不是通用检测器，不要直接用。**
 *
 * 这些定义来自一个具体项目的真实踩坑记录，仅用来说明 `detect()` 该怎么写。
 * 你必须按**自己项目**的实际问题替换它们。
 *
 * ## 用法
 *
 *   node scripts/research/strata-events.mjs \
 *     --pitfalls examples/pitfalls-example.mjs \
 *     --sessions-dir ~/your-agent-logs --filter 'myproject'
 *
 * ## 每条陷阱的字段
 *
 *   id        稳定标识（出现在输出与 JSON 里）
 *   name      人读的名字
 *   ruleForm  它当时的**散文**形态（规则写在哪个文档里）
 *   checkForm 它当时的**可执行**形态（哪条命令能判它）
 *   detect(args, toolName) -> boolean
 *
 * ## 两条纪律（重复，因为最容易违反）
 *
 * **1. `detect()` 匹配的是"形态"，不一定等于"确认的违规"。**
 *    下面第一个检测器匹配"模板字面量内的注释里出现反引号"这个形态 ——
 *    但**反引号成对时并不构成语法错误**。
 *    报告时必须写"模式匹配 N 次"，不能写"违规 N 次"。
 *
 * **2. 只定义能被机检的陷阱。**
 *    "需求理解偏差"这类主观问题无法从日志里可靠识别，硬检测只会产出噪声。
 */

const BT = String.fromCharCode(96) // 反引号

export const PITFALLS = [
  {
    id: 'backtick-in-template-comment',
    name: '模板字面量注释里的反引号',
    ruleForm: '项目约定文档里写明：模板字面量内部的注释不要出现反引号',
    checkForm: '一条用 Node 解析器判定语法是否可解析的命令',
    /**
     * 特征：进入模板字面量后，某条注释行里又出现反引号。
     *
     * ⚠️ 这是**形态匹配**，会高估：反引号成对配平时解析器照样通过。
     *    实测 —— 把该形态注入真实文件后，可执行检查器报告通过（0/2 抓住）。
     */
    detect(args, toolName) {
      if (!/edit|write|patch|replace/i.test(toolName)) return false
      const text = String(args.new_string ?? args.content ?? args.text ?? '')
      if (!text) return false
      const lines = text.split('\n')
      let inTemplate = false
      for (const line of lines) {
        const count = line.split(BT).length - 1
        const isComment = /^\s*(\*|\/\*|\/\/|#)/.test(line)
        if (inTemplate && isComment && count > 0) return true
        if (count % 2 === 1) inTemplate = !inTemplate
      }
      return false
    },
  },

  {
    id: 'hand-built-url-instead-of-helper',
    name: '手拼 URL 而不是用统一的路径构造函数',
    ruleForm: '项目约定文档里写明：对外地址必须经统一的路径构造函数产出',
    checkForm: '断言"渲染结果里所有对外地址都带正确前缀"',
    /**
     * 特征：在字符串里手拼 `${...}/` 形式的路径片段。
     * 这类手拼最容易漏掉统一前缀或作用域，而漏掉时**不会报错**，
     * 只会让请求落到错误的地方 —— 典型的静默失败。
     */
    detect(args, toolName) {
      if (!/edit|write|patch|replace/i.test(toolName)) return false
      const text = String(args.new_string ?? args.content ?? args.text ?? '')
      if (!text) return false
      return /[`"']\/\$\{[^}]{1,40}\}\//.test(text)
    },
  },

  {
    id: 'registration-in-wrong-scope',
    name: '需要公开的入口注册在了需要鉴权的作用域里',
    ruleForm: '代码注释：公开入口必须注册在公开作用域',
    checkForm: '在真实宿主上跑端到端断言（直接注入调用验证不出来）',
    /**
     * 特征（弱）：注册了一个形如 `/:id` 的路由，但同一段里没有公开作用域的标记。
     *
     * ⚠️ 这是**弱特征**，误报率高。示例保留它，是为了展示
     *    "宁可标注为弱特征，也不要假装精确"。
     */
    detect(args, toolName) {
      if (!/edit|write|patch|replace/i.test(toolName)) return false
      const text = String(args.new_string ?? args.content ?? args.text ?? '')
      if (!text) return false
      const registersParamRoute = /\.(get|post|put|delete)\s*\(\s*['"`]\/:[A-Za-z]/.test(text)
      const hasPublicScope = /public|anonymous|no-?auth/i.test(text)
      return registersParamRoute && !hasPublicScope
    },
  },
]

export default PITFALLS
