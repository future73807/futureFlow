import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

/**
 * 管理员后台接口
 * 所有接口都需要管理员权限
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ============ 仪表盘 ============

  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  // ============ 用户管理 ============

  @Get('users')
  async listUsers(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.adminService.listUsers(parseInt(page, 10), parseInt(pageSize, 10));
  }

  @Patch('users/:id/balance')
  async adjustBalance(
    @Param('id') id: string,
    @Body() body: { delta: number; remark?: string },
  ) {
    return this.adminService.adjustBalance(id, body.delta, body.remark || '');
  }

  @Patch('users/:id/vip')
  async updateVipLevel(@Param('id') id: string, @Body() body: { vipLevel: string }) {
    return this.adminService.updateVipLevel(id, body.vipLevel);
  }

  @Patch('users/:id/status')
  async updateUserStatus(@Param('id') id: string, @Body() body: { status: string }) {
    return this.adminService.updateUserStatus(id, body.status);
  }

  @Delete('users/:id')
  async deleteUser(@Param('id') id: string) {
    return this.adminService.deleteUser(id);
  }

  // ============ API Key 管理 ============

  @Get('api-keys')
  async listApiKeys(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.adminService.listApiKeys(parseInt(page, 10), parseInt(pageSize, 10));
  }

  @Delete('api-keys/:id')
  async revokeApiKey(@Param('id') id: string) {
    return this.adminService.revokeApiKey(id);
  }

  // ============ 工作流管理 ============

  @Get('workflows')
  async listWorkflows(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.adminService.listWorkflows(parseInt(page, 10), parseInt(pageSize, 10));
  }

  // ============ 运行记录 ============

  @Get('runs')
  async listRuns(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.adminService.listRuns(parseInt(page, 10), parseInt(pageSize, 10));
  }

  // ============ 余额流水 ============

  @Get('balance-logs')
  async listBalanceLogs(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
    @Query('userId') userId?: string,
  ) {
    return this.adminService.listBalanceLogs(
      parseInt(page, 10),
      parseInt(pageSize, 10),
      userId,
    );
  }
}
