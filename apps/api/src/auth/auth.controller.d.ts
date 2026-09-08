import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, UpgradeTierDto } from './dto/auth.dto';
export declare class AuthController {
    private readonly authService;
    constructor(authService: AuthService);
    register(body: RegisterDto): Promise<{
        user: {
            id: string;
            email: string;
            name: string | null;
            role: import(".prisma/client").$Enums.Role;
            tier: import(".prisma/client").$Enums.SubscriptionTier;
        };
        accessToken: string;
    }>;
    login(body: LoginDto): Promise<{
        user: {
            id: string;
            email: string;
            name: string | null;
            role: import(".prisma/client").$Enums.Role;
            tier: import(".prisma/client").$Enums.SubscriptionTier;
        };
        accessToken: string;
    }>;
    getProfile(req: any): Promise<{
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
    upgradeTier(req: any, body: UpgradeTierDto): Promise<{
        success: boolean;
        tier: import(".prisma/client").$Enums.SubscriptionTier;
        validUntil: Date | null;
    }>;
}
