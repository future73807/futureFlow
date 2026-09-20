import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { User } from '../database/entities/user.entity';
import { PythonExecController } from './python-exec.controller';

/** 本地试运行的扩展执行代理：本机 Python 执行 */
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([User])],
  controllers: [PythonExecController],
})
export class LocalToolsModule {}