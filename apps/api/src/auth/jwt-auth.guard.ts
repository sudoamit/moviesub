import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest(err: any, user: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('Authentication token is required');
    }
    return user;
  }
}

@Injectable()
export class ProTierGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) return false;

    // Free users cannot access Pro/Advanced gated routes
    return user.tier === 'PRO' || user.tier === 'ADVANCED' || user.role === 'ADMIN';
  }
}
