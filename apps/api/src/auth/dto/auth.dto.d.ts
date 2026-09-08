import { SubscriptionTier } from '@quant/shared';
export declare class RegisterDto {
    email: string;
    password: string;
    name?: string;
}
export declare class LoginDto {
    email: string;
    password: string;
}
export declare class UpgradeTierDto {
    tier: SubscriptionTier;
}
