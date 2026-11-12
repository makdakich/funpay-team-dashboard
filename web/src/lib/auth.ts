import type { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from './supabase';
import { getErrorMessage } from './errors';
import type { Profile } from '@/types/database';

export type AuthState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'signed-out' }
  | { status: 'profile-error'; user: User; message: string }
  | { status: 'inactive'; user: User }
  | { status: 'active'; user: User; session: Session; profile: Profile };

type AuthListener = (state: AuthState) => void;

export class AuthService {
  private state: AuthState = { status: 'loading' };
  private listeners = new Set<AuthListener>();
  private authSubscription: { unsubscribe: () => void } | null = null;
  private validationGeneration = 0;

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: AuthListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(state: AuthState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  async initialize(): Promise<void> {
    if (!supabaseConfigured) {
      this.setState({ status: 'unconfigured' });
      return;
    }

    const { data, error } = await supabase.auth.getSession();
    if (error) {
      this.setState({ status: 'signed-out' });
    } else {
      await this.validateSession(data.session);
    }

    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') return;
      queueMicrotask(() => void this.handleAuthChange(event, session));
    });
    this.authSubscription = authListener.subscription;
  }

  private async handleAuthChange(event: AuthChangeEvent, session: Session | null): Promise<void> {
    if (event === 'SIGNED_OUT' || !session) {
      this.validationGeneration += 1;
      this.setState({ status: 'signed-out' });
      return;
    }
    await this.validateSession(session);
  }

  private async validateSession(session: Session | null): Promise<void> {
    if (!session) {
      this.setState({ status: 'signed-out' });
      return;
    }

    const generation = ++this.validationGeneration;
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id,display_name,role,is_active,is_creator,invitation_status,invited_by_user_id')
      .eq('user_id', session.user.id)
      .maybeSingle();

    if (generation !== this.validationGeneration) return;
    if (error) {
      this.setState({ status: 'profile-error', user: session.user, message: getErrorMessage(error) });
      return;
    }
    if (!data || data.is_active !== true) {
      this.setState({ status: 'inactive', user: session.user });
      return;
    }

    this.setState({
      status: 'active',
      user: session.user,
      session,
      profile: data as Profile
    });
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!supabaseConfigured) throw new Error('Supabase не настроен. Заполните web/.env по примеру web/.env.example.');
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
    await this.validateSession(data.session);
    if (this.state.status === 'inactive') {
      await supabase.auth.signOut({ scope: 'local' });
      throw new Error('Профиль не найден или отключён. Попросите владельца команды активировать доступ.');
    }
    if (this.state.status === 'profile-error') throw new Error(this.state.message);
  }

  async signOut(): Promise<void> {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;
    this.setState({ status: 'signed-out' });
  }

  dispose(): void {
    this.authSubscription?.unsubscribe();
    this.authSubscription = null;
    this.listeners.clear();
  }
}
