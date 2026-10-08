# 时芽 · Windows 桌宠

C 方案的 Q 版专注精灵，在 Electron 中使用独立透明置顶窗口。应用启动时唤出，主窗口隐藏到托盘后继续显示；退出应用时一起退出。网页/PWA 不启用桌面窗口。

双击项目根目录的 `start_shiya.bat` 可只唤出桌宠，不自动展示学习桌窗口。点击桌宠下方名字即可打开学习桌。

该入口会清除测试/预览环境参数，使用主程序的正常数据目录（用户目录下的 `.my-study-table`）。主程序已经运行时，通过单实例锁唤出同一进程的桌宠；点击桌宠打开的是该进程原来的主窗口，不另建一套数据或窗口。旧 `.shiya-preview-profile` 仅为此前的预览数据，启动入口不再使用。

- 点击时芽：挥手、庆祝等逐帧动作，以及鼓励短句。
- 拖动角色：移动桌宠；聚焦后也可用方向键移动。
- 右键或点击省略号：选择动作（待机眨眼、走路、挥手、看书翻页、打盹、庆祝）、大小调整（小/标准/大）、安静陪伴、打开学习桌、收起。
- 设置 → 外观 → 启用桌宠：勾选显示，取消勾选关闭；保留重启后的选择。托盘也可以唤出/收起，开关状态同步更新。
- 开始专注时看书，暂停时打盹，完成待办时庆祝。空闲时每 20 秒随机做动作；散步会在桌面上移动一小段。安静模式隐藏自动气泡并暂停动画。
- 大小、位置、显示状态和安静模式保存在本机 userData/desktop-pet.json；重新启动恢复，屏幕变化时约束到可见区域。

角色素材：`icons/pet/shiya.png`。使用内置 image_gen，从 C 方案生成透明 PNG。动作素材位于 `icons/pet/actions/`，六套 2×2 四帧透明图，共 24 帧，通过 Canvas 逐帧播放。遵循系统减少动画设置。

生成提示词：

Edit the reference character into ONE standalone adorable chibi desktop pet sprite of C, Shiya the focus fairy. Preserve recognizable silver-lavender twin ponytails, mint sprout leaf hair ribbons, blue eyes, cobalt and ivory sporty sailor jacket, blue skirt, opaque dark leggings, sneakers, little book pouch and tiny timer. 2.5-head chibi proportions, oversized cute head, tiny compact body, simplify small ornamentation so readable at 150 pixels. Full body in friendly neutral standing pose, both feet visible, one hand giving a little wave, other holding a small blue timer. Soft happy smile with open eyes. Clean high-quality anime cel shading, crisp outlines, controlled blue/lilac/mint colors. Character alone, centered filling frame with small padding, no second character, no text, no scenery, no ground, no shadow plane. True transparent background, clean alpha.
