import { ClientSummary, FunPayOrder } from '../../shared/types';
import { aggregateClients } from '../../shared/utils';

/**
 * Users / Clients Adapter
 * Groups customers strictly using buyerId as the primary unique key.
 * Keeps buyerUsername as the display name.
 */
export class FunPayClientsAdapter {
  /**
   * Aggregate client database from order history
   */
  public static fromOrders(orders: FunPayOrder[]): ClientSummary[] {
    return aggregateClients(orders);
  }
}
