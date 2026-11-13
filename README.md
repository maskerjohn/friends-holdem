# 朋友德州扑克

只用筹码，不涉及真钱。最多 6 人一桌，各地用同一个房间号就能一起玩。

本地运行：`npm install && npm start`，然后打开 http://127.0.0.1:8787

## 发布到 Railway（不用绑卡）

Railway 免费试用不用绑卡，试用结束后会自动变成每月 $1 额度的 Free 套餐，仍然不用绑卡。请用 GitHub 账号登录。

1. 打开 https://railway.com/login ，用 GitHub 登录（授权读取仓库 `maskerjohn/friends-holdem`）。
2. 打开 https://railway.com/new ，选 **Deploy from GitHub repo**，选择仓库 `maskerjohn/friends-holdem`，分支 `main`，点 **Deploy Now**。
3. 部署成功后，点这个服务 → **Settings** → **Networking** → **Public Networking** → **Generate Domain**，得到 `https://….up.railway.app` 这样的链接。
4. 在同一页的 **Settings → Regions**（或 Deploy / Region）里把地区改成 **Southeast Asia Metal（Singapore）**，离国内更近。
5. 不要打开 **Serverless / App Sleeping**。打开后没人玩就会休眠，房间里的牌局会丢。

把生成的链接发给朋友即可。大家输入同一个房间号就能进同一桌。

注意：Free 套餐每月只有约 $1 额度。程序一直开着会按实际占用的内存计费（大约 $10/GB/月）。如果额度用完，服务会停，要等下个月额度刷新，或升级付费套餐。刚注册还有 30 天、$5 的试用额度。

如果 GitHub 账号较新，Railway 可能把试用标成 Limited Trial（出站网络受限）。可到 https://railway.com/verify 申请验证。一般只做网页和 WebSocket 进房，不受影响。
