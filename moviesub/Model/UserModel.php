<?php
require_once PROJECT_ROOT_PATH . "/Model/Database.php";
class UserModel extends Database
{
    public function getUsers($limit)
    {

        return $this->select("SELECT * FROM users ORDER BY id ASC LIMIT ?", ["i", $limit]);
    }
}