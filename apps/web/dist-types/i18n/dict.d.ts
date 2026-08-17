export type Lang = "zh" | "en";
declare const dict: {
    readonly "app.title": {
        readonly zh: "投研工作台";
        readonly en: "Research desk";
    };
    readonly "app.brand": {
        readonly zh: "PI";
        readonly en: "PI";
    };
    readonly "rail.tracking": {
        readonly zh: "在跟踪";
        readonly en: "TRACKING";
    };
    readonly "rail.inbox": {
        readonly zh: "收件箱";
        readonly en: "Inbox";
    };
    readonly "rail.settings": {
        readonly zh: "设置";
        readonly en: "Settings";
    };
    readonly "rail.newProject": {
        readonly zh: "新建项目";
        readonly en: "New project";
    };
    readonly "rail.search": {
        readonly zh: "搜索项目 / 代码";
        readonly en: "Search project / ticker";
    };
    readonly "rail.ready": {
        readonly zh: "索引就绪";
        readonly en: "Index ready";
    };
    readonly "rail.noProjects": {
        readonly zh: "还没有项目，先创建一个";
        readonly en: "No projects yet — create one";
    };
    readonly "rail.docs": {
        readonly zh: "份资料";
        readonly en: "docs";
    };
    readonly "rail.chats": {
        readonly zh: "个会话";
        readonly en: "chats";
    };
    readonly "rail.logout": {
        readonly zh: "退出登录";
        readonly en: "Log out";
    };
    readonly "auth.login": {
        readonly zh: "登录";
        readonly en: "Log in";
    };
    readonly "auth.email": {
        readonly zh: "邮箱";
        readonly en: "Email";
    };
    readonly "auth.password": {
        readonly zh: "密码";
        readonly en: "Password";
    };
    readonly "auth.failed": {
        readonly zh: "登录失败，请检查邮箱和密码";
        readonly en: "Login failed — check email and password";
    };
    readonly "auth.register": {
        readonly zh: "注册";
        readonly en: "Sign up";
    };
    readonly "auth.reset": {
        readonly zh: "忘记密码";
        readonly en: "Forgot password";
    };
    readonly "auth.resetSubmit": {
        readonly zh: "重置密码";
        readonly en: "Reset password";
    };
    readonly "auth.resetDone": {
        readonly zh: "密码已重置，请用新密码登录";
        readonly en: "Password reset — log in with the new password";
    };
    readonly "auth.code": {
        readonly zh: "邮箱验证码";
        readonly en: "Email code";
    };
    readonly "auth.sendCode": {
        readonly zh: "发送验证码";
        readonly en: "Send code";
    };
    readonly "auth.codeSendFailed": {
        readonly zh: "验证码发送失败";
        readonly en: "Failed to send code";
    };
    readonly "auth.newPassword": {
        readonly zh: "新密码（至少 8 位）";
        readonly en: "New password (min 8 chars)";
    };
    readonly "auth.nickname": {
        readonly zh: "昵称（可选）";
        readonly en: "Nickname (optional)";
    };
    readonly "auth.submitFailed": {
        readonly zh: "提交失败，请检查填写内容";
        readonly en: "Submit failed — check your input";
    };
    readonly "project.create.title": {
        readonly zh: "新建投研项目";
        readonly en: "New research project";
    };
    readonly "project.create.name": {
        readonly zh: "项目名称";
        readonly en: "Project name";
    };
    readonly "project.create.company": {
        readonly zh: "公司名称（可选）";
        readonly en: "Company name (optional)";
    };
    readonly "project.create.ticker": {
        readonly zh: "代码（可选）";
        readonly en: "Ticker (optional)";
    };
    readonly "project.create.submit": {
        readonly zh: "创建";
        readonly en: "Create";
    };
    readonly "project.delete": {
        readonly zh: "删除";
        readonly en: "Delete";
    };
    readonly "project.delete.confirm": {
        readonly zh: "删除该项目及其全部资料与会话？此操作不可撤销。";
        readonly en: "Delete this project with all documents and chats? This cannot be undone.";
    };
    readonly "common.cancel": {
        readonly zh: "取消";
        readonly en: "Cancel";
    };
    readonly "common.close": {
        readonly zh: "关闭";
        readonly en: "Close";
    };
    readonly "common.loading": {
        readonly zh: "加载中…";
        readonly en: "Loading…";
    };
    readonly "common.error": {
        readonly zh: "加载失败";
        readonly en: "Failed to load";
    };
    readonly "common.retry": {
        readonly zh: "重试";
        readonly en: "Retry";
    };
    readonly "common.empty": {
        readonly zh: "暂无数据";
        readonly en: "Nothing here yet";
    };
    readonly "common.confirm": {
        readonly zh: "确认";
        readonly en: "Confirm";
    };
    readonly "common.copy": {
        readonly zh: "复制";
        readonly en: "Copy";
    };
    readonly "common.download": {
        readonly zh: "下载";
        readonly en: "Download";
    };
    readonly "common.missing": {
        readonly zh: "数据缺失";
        readonly en: "n/a";
    };
    readonly "workbench.pickProject": {
        readonly zh: "从左侧选择一个项目开始研究";
        readonly en: "Pick a project on the left to start";
    };
    readonly "workbench.upload": {
        readonly zh: "资料上传";
        readonly en: "Upload";
    };
    readonly "workbench.upload.hint": {
        readonly zh: "拖入年报、卖方研究或估值模型";
        readonly en: "Drop filings, sell-side notes or models";
    };
    readonly "workbench.upload.choose": {
        readonly zh: "选择文件上传";
        readonly en: "Choose files";
    };
    readonly "workbench.upload.types": {
        readonly zh: "PDF · XLSX · DOCX · PPTX · CSV · MD · TXT";
        readonly en: "PDF · XLSX · DOCX · PPTX · CSV · MD · TXT";
    };
    readonly "workbench.upload.uploading": {
        readonly zh: "上传中…";
        readonly en: "Uploading…";
    };
    readonly "workbench.upload.done": {
        readonly zh: "上传完成";
        readonly en: "Uploaded";
    };
    readonly "workbench.upload.failed": {
        readonly zh: "上传失败";
        readonly en: "Upload failed";
    };
    readonly "workbench.chats": {
        readonly zh: "研究会话";
        readonly en: "Research chats";
    };
    readonly "workbench.newChat": {
        readonly zh: "新会话";
        readonly en: "New chat";
    };
    readonly "workbench.msgs": {
        readonly zh: "消息";
        readonly en: "MSGS";
    };
    readonly "workbench.askCorpus": {
        readonly zh: "向当前项目的资料提问";
        readonly en: "Ask this project's corpus";
    };
    readonly "workbench.suggest.vbp": {
        readonly zh: "集采影响测算";
        readonly en: "VBP impact";
    };
    readonly "workbench.suggest.pipeline": {
        readonly zh: "管线估值拆分";
        readonly en: "Pipeline value";
    };
    readonly "workbench.suggest.quarter": {
        readonly zh: "季度业绩归因";
        readonly en: "Quarter attribution";
    };
    readonly "workbench.chat.empty": {
        readonly zh: "选择上方任一会话展开对话，上传区与资料列表保持可见";
        readonly en: "Open a chat above — upload and documents stay in place";
    };
    readonly "chat.stop": {
        readonly zh: "中断";
        readonly en: "Stop";
    };
    readonly "chat.fork": {
        readonly zh: "分叉";
        readonly en: "Fork";
    };
    readonly "chat.collapse": {
        readonly zh: "收起";
        readonly en: "Collapse";
    };
    readonly "chat.me": {
        readonly zh: "我";
        readonly en: "ME";
    };
    readonly "chat.reasoning": {
        readonly zh: "推理过程";
        readonly en: "REASONING";
    };
    readonly "chat.steps": {
        readonly zh: "步";
        readonly en: "STEPS";
    };
    readonly "chat.context": {
        readonly zh: "本轮上下文";
        readonly en: "CONTEXT";
    };
    readonly "chat.draftQueued": {
        readonly zh: "生成中，发送将排队";
        readonly en: "Generating — sends are queued";
    };
    readonly "chat.composer.placeholder": {
        readonly zh: "继续追问…";
        readonly en: "Ask a follow-up…";
    };
    readonly "chat.composer.queued": {
        readonly zh: "继续追问…（生成中，将排队）";
        readonly en: "Ask a follow-up… (queued while generating)";
    };
    readonly "chat.attach": {
        readonly zh: "附件（即将支持）";
        readonly en: "Attach (coming soon)";
    };
    readonly "chat.voice": {
        readonly zh: "语音输入（即将支持）";
        readonly en: "Voice (coming soon)";
    };
    readonly "chat.skills": {
        readonly zh: "技能（即将支持）";
        readonly en: "Skills (coming soon)";
    };
    readonly "chat.send": {
        readonly zh: "发送";
        readonly en: "Send";
    };
    readonly "chat.queue": {
        readonly zh: "排队发送";
        readonly en: "Queue";
    };
    readonly "chat.running": {
        readonly zh: "生成中";
        readonly en: "RUNNING";
    };
    readonly "chat.idle": {
        readonly zh: "就绪";
        readonly en: "READY";
    };
    readonly "chat.interrupted": {
        readonly zh: "已中断";
        readonly en: "INTERRUPTED";
    };
    readonly "chat.failed": {
        readonly zh: "失败";
        readonly en: "FAILED";
    };
    readonly "chat.compact": {
        readonly zh: "压缩上下文";
        readonly en: "Compact";
    };
    readonly "approval.title": {
        readonly zh: "审批请求";
        readonly en: "APPROVAL";
    };
    readonly "approval.approve": {
        readonly zh: "批准";
        readonly en: "Approve";
    };
    readonly "approval.reject": {
        readonly zh: "拒绝";
        readonly en: "Reject";
    };
    readonly "board.title": {
        readonly zh: "研究看板";
        readonly en: "Research board";
    };
    readonly "board.documents": {
        readonly zh: "项目资料";
        readonly en: "Documents";
    };
    readonly "board.memo": {
        readonly zh: "投资备忘录";
        readonly en: "Memo";
    };
    readonly "board.valuation": {
        readonly zh: "估值跟踪";
        readonly en: "Valuation";
    };
    readonly "board.risks": {
        readonly zh: "风险与催化剂";
        readonly en: "Risks & catalysts";
    };
    readonly "board.toContext": {
        readonly zh: "加入上下文";
        readonly en: "To context";
    };
    readonly "board.selected": {
        readonly zh: "已选";
        readonly en: "selected";
    };
    readonly "docs.search": {
        readonly zh: "搜索资料…";
        readonly en: "Search documents…";
    };
    readonly "docs.delete.confirm": {
        readonly zh: "删除所选资料？";
        readonly en: "Delete selected documents?";
    };
    readonly "memo.versions": {
        readonly zh: "历史版本";
        readonly en: "History";
    };
    readonly "memo.compare": {
        readonly zh: "比较";
        readonly en: "Compare";
    };
    readonly "memo.generate": {
        readonly zh: "生成 Memo";
        readonly en: "Generate memo";
    };
    readonly "memo.added": {
        readonly zh: "新增";
        readonly en: "ADDED";
    };
    readonly "memo.changed": {
        readonly zh: "变化";
        readonly en: "CHANGED";
    };
    readonly "memo.unavailable": {
        readonly zh: "Memo 服务未启用";
        readonly en: "Memo service disabled";
    };
    readonly "valuation.run": {
        readonly zh: "刷新";
        readonly en: "Refresh";
    };
    readonly "valuation.price": {
        readonly zh: "现价";
        readonly en: "Price";
    };
    readonly "valuation.implied": {
        readonly zh: "模型隐含";
        readonly en: "Implied";
    };
    readonly "valuation.metric": {
        readonly zh: "指标";
        readonly en: "Metric";
    };
    readonly "valuation.model": {
        readonly zh: "模型";
        readonly en: "Model";
    };
    readonly "valuation.actual": {
        readonly zh: "实际";
        readonly en: "Actual";
    };
    readonly "valuation.gap": {
        readonly zh: "差异";
        readonly en: "Gap";
    };
    readonly "valuation.derived.pending": {
        readonly zh: "派生模型待确认入库";
        readonly en: "Derived model awaiting confirmation";
    };
    readonly "risks.risk": {
        readonly zh: "风险";
        readonly en: "RISK";
    };
    readonly "risks.catalyst": {
        readonly zh: "催化剂";
        readonly en: "Catalyst";
    };
    readonly "risks.unread": {
        readonly zh: "未读";
        readonly en: "UNREAD";
    };
    readonly "risks.acknowledge": {
        readonly zh: "确认";
        readonly en: "Acknowledge";
    };
    readonly "inbox.title": {
        readonly zh: "全局上传收件箱";
        readonly en: "Global upload inbox";
    };
    readonly "inbox.route": {
        readonly zh: "改派";
        readonly en: "Assign";
    };
    readonly "inbox.matched": {
        readonly zh: "已匹配项目";
        readonly en: "Matched";
    };
    readonly "inbox.review": {
        readonly zh: "人工复核";
        readonly en: "Review";
    };
};
export type DictKey = keyof typeof dict;
export declare function translate(key: DictKey, lang: Lang): string;
export declare const dictKeys: DictKey[];
export default dict;
//# sourceMappingURL=dict.d.ts.map