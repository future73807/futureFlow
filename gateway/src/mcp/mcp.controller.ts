import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Request,
  UnauthorizedException,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt.guard';
import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { McpExecutionGuard } from './mcp-execution.guard';
import { McpService } from './mcp.service';

class CreateMcpServerDto {
  @IsString()
  @MinLength(1, { message: 'MCP 服务器名称不能为空' })
  @MaxLength(80, { message: 'MCP 服务器名称不能超过 80 个字符' })
  name!: string;

  @IsString()
  @MinLength(1, { message: 'MCP 服务器地址不能为空' })
  @MaxLength(500, { message: 'MCP 服务器地址不能超过 500 个字符' })
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000, { message: 'Bearer 令牌长度无效' })
  token?: string;
}

class McpToolsDto {
  @IsString()
  serverId!: string;
}

class McpProxyDto {
  @IsString()
  serverId!: string;

  @IsString()
  @MinLength(1, { message: '工具名称不能为空' })
  tool!: string;

  @IsOptional()
  @IsObject()
  arguments?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  _scope?: string[];
}

const strictValidation = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

@UsePipes(strictValidation)
@Controller('mcp')
export class McpController {
  constructor(private readonly mcp: McpService) {}

  private currentUserId(req: any): string {
    const userId = req?.user?.id;
    if (!userId) throw new UnauthorizedException('未认证');
    return String(userId);
  }

  private isAdmin(req: any): boolean {
    return req?.user?.role === 'admin';
  }

  @Get('servers')
  @UseGuards(JwtAuthGuard)
  listServers(@Request() req: any) {
    return this.mcp.listServers(this.currentUserId(req));
  }

  @Post('servers')
  @UseGuards(JwtAuthGuard)
  createServer(@Request() req: any, @Body() dto: CreateMcpServerDto) {
    return this.mcp.createServer(
      this.currentUserId(req),
      dto.name.trim(),
      dto.url,
      dto.token?.trim() || '',
    );
  }

  @Delete('servers/:serverId')
  @UseGuards(JwtAuthGuard)
  deleteServer(@Request() req: any, @Param('serverId') serverId: string) {
    return this.mcp.deleteServer(this.currentUserId(req), serverId, this.isAdmin(req));
  }

  @Post('servers/:serverId/tools')
  @UseGuards(JwtAuthGuard)
  listTools(@Request() req: any, @Param('serverId') serverId: string) {
    return this.mcp.listTools(this.currentUserId(req), serverId, this.isAdmin(req));
  }

  /** 供 Dify HTTP 节点在运行时调用（MCP 执行短令牌）。 */
  @Post('proxy')
  @UseGuards(McpExecutionGuard)
  proxy(@Request() req: any, @Body() dto: McpProxyDto) {
    // 工具参数体积上限：防止超大 payload 打满网关与上游 MCP 服务器。
    if (dto.arguments !== undefined && JSON.stringify(dto.arguments).length > 65_536) {
      throw new BadRequestException('MCP 工具参数序列化后不能超过 64 KB');
    }
    const scope = req.mcpExecution;
    return this.mcp.callTool(
      this.currentUserId(req),
      { serverId: dto.serverId, tool: dto.tool, arguments: dto.arguments },
      this.isAdmin(req),
    );
  }
}
