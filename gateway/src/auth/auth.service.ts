import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { User } from '../database/entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { LoginRateLimitService } from './login-rate-limit.service';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly loginRateLimit: LoginRateLimitService,
  ) {}

  async register(dto: RegisterDto, clientKey = 'unknown') {
    // 注册防刷：同一来源 1 小时窗口内每次尝试都计数（上限 20 次）。
    this.loginRateLimit.assertRegisterAllowed(`register|${clientKey}`);
    this.loginRateLimit.recordRegisterAttempt(`register|${clientKey}`);
    const existingUsername = await this.userRepo.findOne({
      where: { username: dto.username },
    });
    if (existingUsername) {
      throw new ConflictException('用户名已被注册');
    }

    const existingEmail = await this.userRepo.findOne({
      where: { email: dto.email },
    });
    if (existingEmail) {
      throw new ConflictException('邮箱已被注册');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const user = this.userRepo.create({
      username: dto.username,
      email: dto.email,
      passwordHash,
      vipLevel: 'free',
      balance: 10,
      frozenBalance: 0,
      status: 'active',
    });
    await this.userRepo.save(user);

    return {
      ...this.generateTokens(user),
      user: this.sanitizeUser(user),
    };
  }

  async login(dto: LoginDto, clientKey = 'unknown') {
    this.loginRateLimit.assertAllowed(clientKey);
    const fail = () => this.loginRateLimit.recordFailure(clientKey);
    const user = await this.userRepo.findOne({
      where: [{ username: dto.account }, { email: dto.account }],
    });

    if (!user || !user.passwordHash) {
      fail();
      throw new UnauthorizedException('账号或密码错误');
    }

    if (user.status !== 'active') {
      fail();
      throw new UnauthorizedException('账号已被封禁或暂停');
    }

    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) {
      fail();
      throw new UnauthorizedException('账号或密码错误');
    }

    this.loginRateLimit.reset(clientKey);
    return {
      ...this.generateTokens(user),
      user: this.sanitizeUser(user),
    };
  }

  async getProfile(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return this.sanitizeUser(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    const username = dto.username?.trim();
    const email = dto.email?.trim().toLowerCase();
    if (username && username !== user.username) {
      const existing = await this.userRepo.findOne({ where: { username } });
      if (existing) throw new ConflictException('用户名已存在');
      user.username = username;
    }
    if (email && email !== user.email) {
      const existing = await this.userRepo.findOne({ where: { email } });
      if (existing) throw new ConflictException('邮箱已被注册');
      user.email = email;
    }

    return this.sanitizeUser(await this.userRepo.save(user));
  }

  /** 修改密码：验证当前密码后重置哈希；用户在其他端的会话保持有效（JWT 无状态）。 */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || !user.passwordHash) {
      throw new NotFoundException('用户不存在');
    }
    const isValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('当前密码错误');
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await this.userRepo.save(user);
    return { ok: true };
  }

  private generateTokens(user: User) {
    const payload = {
      sub: user.id,
      username: user.username,
      vipLevel: user.vipLevel,
      role: user.role,
      status: user.status,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      expiresIn: 7 * 24 * 3600,
    };
  }

  private sanitizeUser(user: User) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      vipLevel: user.vipLevel,
      role: user.role,
      balance: parseFloat(user.balance.toString()),
      frozenBalance: parseFloat(user.frozenBalance.toString()),
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
