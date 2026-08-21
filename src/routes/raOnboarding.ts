import { Router, Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { requireRaAuth } from '../auth/raMiddleware';
import { 
  createLinkedAccount, 
  createStakeholder, 
  requestProductConfig, 
  updateProductConfig 
} from '../services/razorpayService';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

// Ensure all routes require RA auth
router.use(requireRaAuth);

router.post('/linked-account', asyncHandler(async (req, res) => {
  const { email, phone, legal_business_name, business_type, contact_name, profile, legal_info } = req.body ?? {};

  try {
    const account = await createLinkedAccount({
      email,
      phone,
      type: 'route',
      legal_business_name,
      business_type,
      contact_name,
      profile,
      legal_info
    });

    await pool.query(
      `UPDATE research_analysts 
       SET razorpay_account_id = $1, onboarding_status = 'account_created', updated_at = now() 
       WHERE id = $2`,
      [account.id, req.authRaId]
    );

    res.status(200).json({ account });
  } catch (err: any) {
    console.error('Error creating linked account:', err);
    res.status(400).json({ error: err.error?.description || 'Failed to create linked account' });
  }
}));

router.post('/stakeholder', asyncHandler(async (req, res) => {
  const { name, email, addresses, kyc, notes } = req.body ?? {};

  try {
    const result = await pool.query('SELECT razorpay_account_id FROM research_analysts WHERE id = $1', [req.authRaId]);
    const accountId = result.rows[0]?.razorpay_account_id;
    if (!accountId) {
      res.status(400).json({ error: 'Linked account not created yet' });
      return;
    }

    const stakeholder = await createStakeholder(accountId, {
      name,
      email,
      addresses,
      kyc,
      notes
    });

    await pool.query(
      `UPDATE research_analysts 
       SET razorpay_stakeholder_id = $1, onboarding_status = 'stakeholder_created', updated_at = now() 
       WHERE id = $2`,
      [stakeholder.id, req.authRaId]
    );

    res.status(200).json({ stakeholder });
  } catch (err: any) {
    console.error('Error creating stakeholder:', err);
    res.status(400).json({ error: err.error?.description || 'Failed to create stakeholder' });
  }
}));

router.post('/product-config', asyncHandler(async (req, res) => {
  const { settlements, tnc_accepted, product_id } = req.body ?? {};

  try {
    const result = await pool.query('SELECT razorpay_account_id FROM research_analysts WHERE id = $1', [req.authRaId]);
    const accountId = result.rows[0]?.razorpay_account_id;
    if (!accountId) {
      res.status(400).json({ error: 'Linked account not created yet' });
      return;
    }

    let product;
    if (product_id) {
      product = await updateProductConfig(accountId, product_id, {
        settlements,
        tnc_accepted
      });
    } else {
      product = await requestProductConfig(accountId, {
        product_name: 'route',
        tnc_accepted: true
      });
      // Once requested, update with settlements
      product = await updateProductConfig(accountId, product.id, {
        settlements,
        tnc_accepted: true
      });
    }

    const activationStatus = product.activation_status;
    const newStatus =
      activationStatus === 'activated'
        ? 'active'
        : activationStatus === 'needs_clarification'
          ? 'needs_clarification'
          : 'under_review';

    await pool.query(
      `UPDATE research_analysts
       SET onboarding_status = $1, razorpay_product_id = $2, updated_at = now()
       WHERE id = $3`,
      [newStatus, product.id, req.authRaId]
    );

    res.status(200).json({ product, status: newStatus });
  } catch (err: any) {
    console.error('Error configuring product:', err);
    res.status(400).json({ error: err.error?.description || 'Failed to configure product' });
  }
}));

export default router;
