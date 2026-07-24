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
import { DifyIntegrationService } from '../dify/dify-integration.service';

function parsePage(value: string, fallback: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * 管理员后台接口
 * 所有接口都需要管理员权限
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly difyIntegration: DifyIntegrationService,
  ) {}

  // ============ 仪表盘 ============

  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  // ============ Dify 受控集成 ============

  @Get('dify/status')
  async getDifyStatus() {
    return this.difyIntegration.getStatus();
  }

  /**
   * Stores a privileged Dify Console authorization once. Each future workflow
   * publication then creates its own Dify app and encrypted app-* key.
   */
  @Post('dify/bootstrap')
  async bootstrapDify(
    @Body()
    body: {
      consoleToken?: string;
      consoleRefreshToken?: string;
      email?: string;
      password?: string;
      consoleBase?: string;
      appId?: string;
    },
  ) {
    return this.difyIntegration.bootstrap(body || {});
  }

  @Post('dify/rotate-key')
  async rotateDifyKey(
    @Body()
    body: {
      consoleToken?: string;
      consoleRefreshToken?: string;
      consoleBase?: string;
      appId?: string;
      workflowId?: string;
      workflowVersion?: number;
    },
  ) {
    return this.difyIntegration.rotateServiceApiKey(body || {});
  }

  // ============ 用户管理 ============

  @Get('users')
  async listUsers(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.adminService.listUsers(parsePage(page, 1, 100000), parsePage(pageSize, 20, 100));
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
    return this.adminService.listApiKeys(parsePage(page, 1, 100000), parsePage(pageSize, 20, 100));
  }

  @Delete('api-keys/:id')
  async revokeApiKey(@Param('id') id: string) {
    return this.adminService.revokeApiKey(id);
  }

  // ============ 工作流管理 ============

  @Get('workflows')
  async listWorkflows(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.adminService.listWorkflows(parsePage(page, 1, 100000), parsePage(pageSize, 20, 100));
  }

  // ============ 运行记录 ============

  @Get('runs')
  async listRuns(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.adminService.listRuns(parsePage(page, 1, 100000), parsePage(pageSize, 20, 100));
  }

  // ============ 余额流水 ============

  @Get('balance-logs')
  async listBalanceLogs(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
    @Query('userId') userId?: string,
  ) {
    return this.adminService.listBalanceLogs(
      parsePage(page, 1, 100000),
      parsePage(pageSize, 50, 100),
      userId,
    );
  }
}
