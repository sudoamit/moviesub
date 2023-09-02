<?php
require_once PROJECT_ROOT_PATH . "/Model/Database.php";
class SubscriptionPlan extends Database
{
    public function getSubscriptionPlan($limit)
    {

        return $this->select("SELECT * FROM subscription_plan ORDER BY id ASC LIMIT ?", ["i", $limit]);
    }
}