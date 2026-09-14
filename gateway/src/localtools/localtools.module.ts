import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { User } from '../database/entities/user.entity';
import { DbQueryController } from './db-query.controller';
import { PythonExecController } from './python-exec.controller';

/** 本地试运行的扩展执行代理: 数据库只读查询 / 本机 Python 执行 */
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([User])],
  controllers: [DbQueryController, PythonExecController],
})
export class LocalToolsModule {}