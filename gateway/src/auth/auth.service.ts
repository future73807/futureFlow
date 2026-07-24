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

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const existingUsername = await this.userRepo.findOne({
      where: { username: dto.username },
    });
    if (existingUsername) {
      throw new ConflictException('用户名已存在');
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

  async login(dto: LoginDto) {
    const user = await this.userRepo.findOne({
      where: [{ username: dto.account }, { email: dto.account }],
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('账号或密码错误');
    }

    if (user.status !== 'active') {
      throw new UnauthorizedException('账号已被封禁或暂停');
    }

    const isValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedException('账号或密码错误');
    }

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

  async validateJwtPayload(payload: any): Promise<User | null> {
    const user = await this.userRepo.findOne({ where: { id: payload.sub } });
    if (!user || user.status !== 'active') {
      return null;
    }
    return user;
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
    };
  }
}
