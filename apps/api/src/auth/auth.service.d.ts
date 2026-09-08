import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../common/prisma/prisma.service';
import { LoginDto, RegisterDto, UpgradeTierDto } from './dto/auth.dto';
export declare class AuthService {
    private readonly prisma;
    private readonly jwtService;
    constructor(prisma: PrismaService, jwtService: JwtService);
    register(dto: RegisterDto): Promise<{
        user: {
            id: string;
            email: string;
            name: string | null;
            role: import(".prisma/client").$Enums.Role;
            tier: import(".prisma/client").$Enums.SubscriptionTier;
        };
        accessToken: string;
    }>;
    login(dto: LoginDto): Promise<{
        user: {
            id: string;
            email: string;
            name: string | null;
            role: import(".prisma/client").$Enums.Role;
            tier: import(".prisma/client").$Enums.SubscriptionTier;
        };
        accessToken: string;
    }>;
    getProfile(userId: string): Promise<{
        id: string;
        email: string;
        name: string | null;
        role: import(".prisma/client").$Enums.Role;
        tier: import(".prisma/client").$Enums.SubscriptionTier;
        subscription: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            isActive: boolean;
            userId: string;
            tier: import(".prisma/client").$Enums.SubscriptionTier;
            validUntil: Date | null;
        } | null;
        alertsCount: number;
    }>;
    upgradeTier(userId: string, dto: UpgradeTierDto): Promise<{
        success: boolean;
        tier: import(".prisma/client").$Enums.SubscriptionTier;
        validUntil: Date | null;
    }>;
    private generateToken;
}
