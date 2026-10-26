// Supabase Configuration
const SUPABASE_URL = 'https://twoykokedsfvihnczlhb.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_04d6tXc2KFfahuYPaL9cZQ_V2vjSueq';

// Initialize Supabase Client
const supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Helper: SHA-256 hash for passwords
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Intercept window.fetch to route CRM backend requests directly to Supabase
const _originalFetch = window.fetch;
window.fetch = async function(url, options = {}) {
  const urlStr = typeof url === 'string' ? url : (url.url || '');
  if (urlStr.includes('action=') || urlStr === '?' || (options.body instanceof FormData && options.body.get('action'))) {
    try {
      const res = await handleSupabaseAction(urlStr, options);
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      console.error('Supabase Action Error:', err);
      return new Response(JSON.stringify({ success: false, message: err.message || 'Database error' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
  return _originalFetch.apply(this, arguments);
};

// Main Action Dispatcher
async function handleSupabaseAction(urlStr, options) {
  let params = new URLSearchParams(urlStr.includes('?') ? urlStr.split('?')[1] : '');
  let action = params.get('action') || '';
  let postData = {};

  if (options.body) {
    if (options.body instanceof FormData) {
      for (const [k, v] of options.body.entries()) {
        postData[k] = v;
      }
      if (postData.action) action = postData.action;
    } else if (typeof options.body === 'string') {
      try {
        postData = JSON.parse(options.body);
        if (postData.action) action = postData.action;
      } catch (e) {
        params = new URLSearchParams(options.body);
        for (const [k, v] of params.entries()) {
          postData[k] = v;
        }
        if (postData.action) action = postData.action;
      }
    }
  }

  const currentUser = JSON.parse(localStorage.getItem('gas_user') || 'null');

  switch (action) {
    case 'login': {
      const username = (postData.username || '').trim();
      const password = (postData.password || '').trim();
      const pwdHash = await sha256(password);

      const { data: users, error } = await supabase
        .from('gas_users')
        .select('*')
        .eq('username', username)
        .eq('active', 1)
        .limit(1);

      if (error || !users || users.length === 0) {
        return { success: false, message: 'Invalid username or password' };
      }

      const u = users[0];
      // Check password (hash or plaintext check)
      if (u.password !== pwdHash && u.password !== password) {
        return { success: false, message: 'Invalid username or password' };
      }

      const userData = {
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role || 'Employee',
        permissions: u.permissions || '*',
        branch_id: u.branch_id || 1
      };
      localStorage.setItem('gas_user', JSON.stringify(userData));
      return { success: true, user: userData };
    }

    case 'logout': {
      localStorage.removeItem('gas_user');
      window.location.reload();
      return { success: true };
    }

    case 'get_init_data': {
      const [settingsRes, branchesRes, vendorsRes] = await Promise.all([
        supabase.from('gas_settings').select('*'),
        supabase.from('gas_branches').select('*').order('id', { ascending: true }),
        supabase.from('gas_vendors').select('*').order('name', { ascending: true })
      ]);

      const settings = {};
      (settingsRes.data || []).forEach(r => { settings[r.setting_key] = r.setting_value; });

      const company = {
        company_name: settings['CompanyName'] || 'Shiv Shakti Hp Gas Agency',
        company_address: settings['CompanyAddress'] || '',
        company_mobile: settings['CompanyMobile'] || '',
        company_email: settings['CompanyEmail'] || '',
        company_logo: settings['CompanyLogo'] || ''
      };

      const sources = (settings['ComplaintSources'] || 'Office Phone,Delivery,Leakage,District Office,MO').split(',');

      return {
        success: true,
        user: currentUser,
        company,
        branches: branchesRes.data || [],
        vendors: vendorsRes.data || [],
        sources,
        settings
      };
    }

    case 'get_complaints': {
      const status = params.get('status') || '';
      const source = params.get('source') || '';
      const tag = params.get('tag') || '';
      const search = params.get('search') || '';
      const page = parseInt(params.get('page') || '1');
      const limit = 50;
      const offset = (page - 1) * limit;

      let query = supabase.from('gas_complaints').select('*', { count: 'exact' }).eq('deleted', 0);

      if (status && status !== 'All') {
        if (status === 'Active') {
          query = query.neq('status', 'Delivered').neq('status', 'Resolved');
        } else {
          query = query.eq('status', status);
        }
      }
      if (source && source !== 'All') {
        query = query.eq('source', source);
      }
      if (tag && tag !== 'All') {
        query = query.eq('tag', tag);
      }
      if (search) {
        query = query.or(`consumer_name.ilike.%${search}%,consumer_number.ilike.%${search}%,mobile.ilike.%${search}%`);
      }

      query = query.order('id', { ascending: false }).range(offset, offset + limit - 1);

      const { data, count, error } = await query;
      if (error) throw error;

      return {
        success: true,
        complaints: data || [],
        total: count || 0,
        page,
        totalPages: Math.ceil((count || 0) / limit)
      };
    }

    case 'get_complaint_details': {
      const id = params.get('id') || postData.id;
      const { data, error } = await supabase.from('gas_complaints').select('*').eq('id', id).single();
      if (error) throw error;
      return { success: true, complaint: data };
    }

    case 'add_complaint': {
      const complaintData = {
        consumer_number: postData.consumer_number || '',
        consumer_name: postData.consumer_name || 'Consumer',
        mobile: postData.mobile || '',
        address: postData.address || '',
        source: postData.source || 'Office Phone',
        complaint: postData.complaint || '',
        tag: postData.tag || '',
        status: postData.status || 'Pending',
        branch_id: postData.branch_id || currentUser?.branch_id || 1,
        created_at: new Date().toISOString()
      };

      const { data, error } = await supabase.from('gas_complaints').insert([complaintData]).select();
      if (error) throw error;
      return { success: true, message: 'Complaint registered successfully', id: data[0].id };
    }

    case 'update_complaint': {
      const id = postData.id;
      const updateData = {
        consumer_number: postData.consumer_number,
        consumer_name: postData.consumer_name,
        mobile: postData.mobile,
        address: postData.address,
        source: postData.source,
        complaint: postData.complaint,
        tag: postData.tag,
        updated_at: new Date().toISOString()
      };

      const { error } = await supabase.from('gas_complaints').update(updateData).eq('id', id);
      if (error) throw error;
      return { success: true, message: 'Complaint updated' };
    }

    case 'delete_complaint': {
      const id = params.get('id') || postData.id;
      const { error } = await supabase.from('gas_complaints').update({
        deleted: 1,
        deleted_at: new Date().toISOString(),
        deleted_by: currentUser?.name || 'Admin'
      }).eq('id', id);
      if (error) throw error;
      return { success: true, message: 'Complaint deleted' };
    }

    case 'assign_vendor': {
      const id = postData.id || params.get('id');
      const vendorId = postData.vendor_id;
      const vendorName = postData.vendor_name || '';

      const { error } = await supabase.from('gas_complaints').update({
        vendor_id: vendorId || null,
        vendor: vendorName,
        status: 'Assigned',
        updated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
      return { success: true, message: 'Vendor assigned successfully' };
    }

    case 'resolve_complaint': {
      const id = postData.id || params.get('id');
      const signature = postData.signature_url || '';

      const { error } = await supabase.from('gas_complaints').update({
        status: 'Delivered',
        signature_url: signature,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
      return { success: true, message: 'Complaint resolved and delivered' };
    }

    case 'mark_delivery_failed': {
      const id = postData.id || params.get('id');
      const { error } = await supabase.from('gas_complaints').update({
        status: 'Failed',
        fail_reason: postData.reason || '',
        fail_notes: postData.notes || '',
        updated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
      return { success: true, message: 'Marked delivery failed' };
    }

    case 'get_analytics': {
      const [allComplaints, vendors, consumersCount] = await Promise.all([
        supabase.from('gas_complaints').select('status, source, created_at').eq('deleted', 0),
        supabase.from('gas_vendors').select('id, name'),
        supabase.from('gas_consumers').select('id', { count: 'exact', head: true })
      ]);

      const list = allComplaints.data || [];
      const stats = {
        total: list.length,
        pending: list.filter(c => c.status === 'Pending').length,
        assigned: list.filter(c => c.status === 'Assigned').length,
        delivered: list.filter(c => c.status === 'Delivered' || c.status === 'Resolved').length,
        failed: list.filter(c => c.status === 'Failed').length,
        total_vendors: (vendors.data || []).length,
        total_consumers: consumersCount.count || 23658
      };
      return { success: true, stats };
    }

    case 'get_vendors': {
      const { data, error } = await supabase.from('gas_vendors').select('*').order('name', { ascending: true });
      if (error) throw error;
      return { success: true, vendors: data || [] };
    }

    case 'add_vendor': {
      const vendor = {
        name: postData.name || '',
        mobile: postData.mobile || '',
        code: postData.code || '',
        notes: postData.notes || '',
        created_at: new Date().toISOString()
      };
      const { data, error } = await supabase.from('gas_vendors').insert([vendor]).select();
      if (error) throw error;
      return { success: true, message: 'Vendor added', vendor: data[0] };
    }

    case 'update_vendor': {
      const id = postData.id;
      const { error } = await supabase.from('gas_vendors').update({
        name: postData.name,
        mobile: postData.mobile,
        code: postData.code,
        notes: postData.notes
      }).eq('id', id);
      if (error) throw error;
      return { success: true, message: 'Vendor updated' };
    }

    case 'delete_vendor': {
      const id = params.get('id') || postData.id;
      const { error } = await supabase.from('gas_vendors').delete().eq('id', id);
      if (error) throw error;
      return { success: true, message: 'Vendor removed' };
    }

    case 'get_consumer_by_mobile_or_number': {
      const term = (params.get('term') || postData.term || '').trim();
      if (!term) return { success: false, message: 'No search term' };

      const { data, error } = await supabase
        .from('gas_consumers')
        .select('*')
        .or(`consumer_number.eq.${term},mobile.eq.${term}`)
        .limit(1);

      if (error || !data || data.length === 0) {
        return { success: false, message: 'Consumer not found' };
      }
      return { success: true, consumer: data[0] };
    }

    case 'get_consumers': {
      const page = parseInt(params.get('page') || '1');
      const limit = 50;
      const offset = (page - 1) * limit;
      const search = params.get('search') || '';

      let query = supabase.from('gas_consumers').select('*', { count: 'exact' });
      if (search) {
        query = query.or(`consumer_number.ilike.%${search}%,consumer_name.ilike.%${search}%,mobile.ilike.%${search}%`);
      }
      query = query.order('id', { ascending: true }).range(offset, offset + limit - 1);

      const { data, count, error } = await query;
      if (error) throw error;

      return {
        success: true,
        consumers: data || [],
        total: count || 0,
        page,
        totalPages: Math.ceil((count || 0) / limit)
      };
    }

    case 'get_consumer_details': {
      const id = params.get('id') || postData.id;
      const { data, error } = await supabase.from('gas_consumers').select('*').eq('id', id).single();
      if (error) throw error;
      return { success: true, consumer: data };
    }

    case 'get_consumer_history': {
      const mobile = params.get('mobile') || postData.mobile;
      const { data, error } = await supabase
        .from('gas_complaints')
        .select('*')
        .eq('mobile', mobile)
        .order('id', { ascending: false });
      if (error) throw error;
      return { success: true, history: data || [] };
    }

    case 'get_history': {
      const status = params.get('status') || 'Delivered';
      const search = params.get('search') || '';
      let query = supabase.from('gas_complaints').select('*').eq('deleted', 0);
      if (status && status !== 'All') {
        query = query.eq('status', status);
      }
      if (search) {
        query = query.or(`consumer_name.ilike.%${search}%,consumer_number.ilike.%${search}%,mobile.ilike.%${search}%`);
      }
      query = query.order('id', { ascending: false }).limit(100);
      const { data, error } = await query;
      if (error) throw error;
      return { success: true, history: data || [] };
    }

    case 'get_settings': {
      const { data, error } = await supabase.from('gas_settings').select('*');
      if (error) throw error;
      const settings = {};
      (data || []).forEach(r => { settings[r.setting_key] = r.setting_value; });
      return { success: true, settings };
    }

    case 'save_branding': {
      const updates = [
        { setting_key: 'CompanyName', setting_value: postData.company_name || '' },
        { setting_key: 'CompanyAddress', setting_value: postData.company_address || '' },
        { setting_key: 'CompanyMobile', setting_value: postData.company_mobile || '' },
        { setting_key: 'CompanyEmail', setting_value: postData.company_email || '' }
      ];
      if (postData.company_logo) {
        updates.push({ setting_key: 'CompanyLogo', setting_value: postData.company_logo });
      }
      const { error } = await supabase.from('gas_settings').upsert(updates);
      if (error) throw error;
      return { success: true, message: 'Settings saved successfully' };
    }

    case 'get_branches': {
      const { data, error } = await supabase.from('gas_branches').select('*').order('id', { ascending: true });
      if (error) throw error;
      return { success: true, branches: data || [] };
    }

    default:
      return { success: false, message: `Action [${action}] handled by adapter default` };
  }
}
