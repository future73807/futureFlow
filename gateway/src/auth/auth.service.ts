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

  /** 修改密码：验证当前密码后重置哈希，并自增 token 版本号强制全部旧会话下线。 */
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
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await this.userRepo.save(user);
    // 签发一个携带新版本号的新 token，让当前会话无缝续期；
    // 其他端的旧 token 版本号落后，会在守卫处被拒。
    return {
      ...this.generateTokens(user),
      user: this.sanitizeUser(user),
    };
  }

  private generateTokens(user: User) {
    const payload = {
      sub: user.id,
      username: user.username,
      vipLevel: user.vipLevel,
      role: user.role,
      status: user.status,
      tv: user.tokenVersion || 0,
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
