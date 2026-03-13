export interface SlackWorkspace {
  id: string;
  team_id: string;
  team_name: string;
  user_id: string;
  scopes: string;
  created_at: string;
  updated_at: string;
}

export interface IntegrationStatus {
  slack: {
    configured: boolean;
    appToken: boolean;
    botToken: boolean;
    workspaces: { teamId: string; teamName: string; userId: string }[];
  };
  google: {
    configured: boolean;
    clientId: boolean;
    services: string;
    accountCount: number;
  };
  discord: {
    configured: boolean;
    botToken: boolean;
  };
  telegram: {
    configured: boolean;
    botToken: boolean;
  };
  whatsapp: {
    configured: boolean;
  };
}

export interface EnvValues {
  [key: string]: string | undefined;
}
