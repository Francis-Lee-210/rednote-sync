# Rednote Sync 工作区

这里集中保存 Rednote Sync 的正式实现、产品设计、研究材料、学习内容和实验代码；各区域相互独立，避免把可发布代码与本地研究材料混在一起。

## 主要入口

- [Rednote Sync Core](projects/rednote-sync-core/README.md)：当前正式实现、运行命令和发布边界。
- [产品文档](docs/README.md)：项目使命、路线图和设计方案。
- [研究目录](research/README.md)：候选项目调研、逆向样本和研究工具。
- [学习目录](learning/README.md)：课程、学习记录、参考页和资源清单。
- [原型目录](prototypes/README.md)：油猴脚本及其他尚未进入正式项目的实验。

运行 Core 的检查或示例前，先进入项目目录：

```bash
cd projects/rednote-sync-core
npm run check
npm test
```

也可以留在工作区根目录执行单个 Core 脚本：

```bash
npm --prefix ./projects/rednote-sync-core run check
```

## 归档规则

- 可持续维护、能够独立运行的实现放入 `projects/<project-name>/`。
- 产品目标和设计决策放入 `docs/`；具体项目的运行和接口文档留在对应项目内部。
- 开源项目调查、逆向样本、证据和工具放入 `research/`。
- 课程、学习笔记和参考资料放入 `learning/`。
- 一次性验证或尚未定型的代码放入 `prototypes/`。
- 凭据、缓存和可重新生成的本机输出不得提交；忽略规则见 [`.gitignore`](.gitignore)。
