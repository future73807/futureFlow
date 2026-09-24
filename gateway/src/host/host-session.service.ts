import { createHash } from 'node:crypto';

import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuthService } from '../auth/auth.service';
import { User } from '../database/entities/user.entity';
import type { HostConfig } from './host.config';
import {
  HOST_CONFIG,
  HOST_IDENTITY,
  type HostIdentity,
  type HostIdentityProvider,
} from './host.types';

/**
 * 宿主会话交换：宿主令牌 → flow 会话（内嵌模式的唯一登录入口）。
 *
 * 「按外部 sub get-or-create」的口径（《flow 集成方案》§3.2 身份缝）：
 *  - 宿主是**身份权威**：displayName / email 每次交换都按宿主给的值更新；
 *  - flow 侧只认 `users.hostSubject` 这个稳定键，用户名 / 密码 / 余额都不参与；
 *  - 宿主用户在 flow 侧的**停用状态不被宿主覆盖**（本地封禁照旧生效），
 *    避免宿主那边一句「已登录」就把本地处置抹掉。
 */
@Injectable()
export class HostSessionService {
  private readonly logger = new Logger(HostSessionService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Inject(HOST_IDENTITY)
    private readonly identityProvider: HostIdentityProvider,
    @Inject(HOST_CONFIG)
    private readonly config: HostConfig,
    private readonly authService: AuthService,
  ) {}

  async exchange(hostToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
    user: ReturnType<AuthService['toProfile']>;
  }> {
    // 独立模式下这里会明确拒绝（见 StandaloneIdentityProvider.resolveIdentity）。
    const identity = await this.identityProvider.resolveIdentity(hostToken);
    const user = await this.getOrCreate(identity);
    const session = this.authService.issueSession(user);
    return { ...session, user: this.authService.toProfile(user) };
  }

  private async getOrCreate(identity: HostIdentity): Promise<User> {
    const existing = await this.userRepo.findOne({
      where: { hostSubject: identity.subject },
    });

    if (existing) {
      if (existing.status !== 'active') {
        throw new ForbiddenException(
          `宿主用户在 flow 侧已被停用（status=${existing.status}）：`
            + '本地处置优先于宿主的登录态，请先在本网关侧解封。',
        );
      }
      return this.syncProfile(existing, identity);
    }

    return this.provision(identity);
  }

  /** 宿主是 displayName / email 的权威源：每次都同步，但不动用户名与本地状态。 */
  private async syncProfile(user: User, identity: HostIdentity): Promise<User> {
    // 宿主给的展示名优先：账号互通要求 flow 界面显示的是宿主账号的身份，
    // 而不是 `host-<hash>` 派生用户名（那只适合当稳定键）。缺失则保留原值。
    const nextDisplayName = identity.displayName?.trim() || null;
    if (nextDisplayName && nextDisplayName !== user.displayName) {
      user.displayName = nextDisplayName;
    }

    // 宿主这一轮没给邮箱时保留原值（邮箱列可空，但**不主动清空**：
    // 清空会让「宿主暂时没带 email」变成一次不可逆的信息丢失）。
    const nextEmail = identity.email ?? user.email;
    if ((!nextEmail || nextEmail === user.email) && user.displayName === nextDisplayName) {
      return user;
    }
    user.email = nextEmail ?? user.email;
    try {
      return await this.userRepo.save(user);
    } catch {
      // 邮箱在 flow 侧是唯一列，宿主可能给两个账号同一个邮箱；它对本网关只是联系信息，
      // 冲突时保留原值即可，不该让登录失败。
      this.logger.warn(
        `宿主身份 ${identity.subject} 的邮箱与已有账号冲突，保留 flow 侧原值。`,
      );
      return user;
    }
  }

  private async provision(identity: HostIdentity): Promise<User> {
    // 宿主用户在本网关没有密码（不许用密码登录，只能由宿主换取会话）。
    const email = identity.email ? await this.availableEmail(identity.email) : null;
    const username = this.deriveUsername(identity.subject);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = attempt === 0 ? username : `${username}-${attempt + 1}`;
      const taken = await this.userRepo.findOne({ where: { username: candidate } });
      if (taken) continue;

      const user = this.userRepo.create({
        username: candidate,
        // 两个列都可空：省略即 NULL。宿主用户在本网关没有本地密码（只能由宿主换取会话），
        // 邮箱可能在 flow 侧已被占用（上面 availableEmail 判过，占用就不写）。
        passwordHash: undefined,
        email: email ?? undefined,
        hostSubject: identity.subject,
        // 账号互通：flow 界面显示宿主账号的展示名（缺失时界面回退用户名）
        ...(identity.displayName?.trim()
          ? { displayName: identity.displayName.trim() }
          : {}),
        // 宿主承担计费时，节点权限不再受 flow 的 VIP 档位约束（默认 pro，可配）；
        // 宿主不承担计费时按 free 起步，照旧受自带余额与档位约束。
        vipLevel: this.config.hostUserVipLevel,
        role: 'user',
        balance: 0,
        frozenBalance: 0,
        status: 'active',
      });
      await this.userRepo.save(user);
      this.logger.log(
        `宿主身份开户: subject=${identity.subject}, username=${candidate}, vip=${user.vipLevel}`,
      );
      return user;
    }

    throw new Error(
      `为宿主身份 ${identity.subject} 开户失败：派生用户名连续冲突。请检查 users 表是否有手工占用的主机名前缀账号。`,
    );
  }

  private async availableEmail(email: string): Promise<string | null> {
    const taken = await this.userRepo.findOne({ where: { email } });
    if (!taken) return email;
    this.logger.warn(`宿主下发邮箱 ${email} 已被占用：本账号不写邮箱（不影响登录）。`);
    return null;
  }

  /**
   * 用户名由 subject 派生（`host-<16 位哈希>`）：稳定、可读、不含宿主可控的字符，
   * 避免宿主用带引号 / 空格的显示名污染 flow 的账号命名空间。
   */
  private deriveUsername(subject: string): string {
    const digest = createHash('sha256').update(subject, 'utf8').digest('hex');
    return `host-${digest.slice(0, 16)}`;
  }
}
